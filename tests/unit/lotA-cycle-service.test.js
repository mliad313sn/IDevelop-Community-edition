'use strict';

// Lot A — CycleService behaviour (L2-02/03/07/10/12/24/26/27/29, L5C-04/05).
// The DB is mocked: every test drives the service with canned rows and asserts
// on the SQL it emits, the audit line it writes and the value it returns.
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
    runInSavepoint: jest.fn(async (fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);

const mockLog = jest.fn(async () => {});
jest.mock('../../src/services/LogService', () => ({ log: mockLog }));

const mockNotify = jest.fn(async () => ({ inapp: 'ok' }));
jest.mock('../../src/services/NotificationService', () => ({ notify: mockNotify }));

const mockClaim = jest.fn(async () => true);
const mockRelease = jest.fn(async () => {});
jest.mock('../../src/jobs/reminders', () => ({ claim: mockClaim, release: mockRelease }));

const CycleService = require('../../src/services/CycleService');

const SUPER = { userType: 'admin', role: 'superadmin', id: 1, username: 'admin' };
const MANAGER = { userType: 'manager', id: 136, username: 'qa.manager' };

/** The last audit row LogService received for `action`. */
const auditFor = (action) =>
    mockLog.mock.calls
        .map((c) => c[0])
        .filter((a) => a.action === action)
        .pop();

beforeEach(() => {
    [mockDb.get, mockDb.all, mockDb.run, mockLog, mockNotify, mockClaim, mockRelease].forEach((m) =>
        m.mockReset()
    );
    mockDb.runTransaction.mockImplementation(async (fn) => fn());
    mockDb.runInSavepoint.mockImplementation(async (fn) => fn());
    mockLog.mockResolvedValue(undefined);
    mockNotify.mockResolvedValue({ inapp: 'ok' });
    mockClaim.mockResolvedValue(true);
    mockRelease.mockResolvedValue(undefined);
    mockDb.run.mockResolvedValue({ changes: 1 });
    mockDb.all.mockResolvedValue([]);
    mockDb.get.mockResolvedValue(null);
});

describe('_pct — never a fabricated 0 (L2-24, product rule 1)', () => {
    test('an empty denominator is null, not 0', () => {
        expect(CycleService._pct(0, 0)).toBeNull();
        expect(CycleService._pct(5, 0)).toBeNull();
        expect(CycleService._pct(0, null)).toBeNull();
        expect(CycleService._pct(0, undefined)).toBeNull();
    });
    test('a real denominator still rounds normally', () => {
        expect(CycleService._pct(0, 41)).toBe(0);
        expect(CycleService._pct(1, 3)).toBe(33);
        expect(CycleService._pct(41, 41)).toBe(100);
    });
});

describe('reopen — locked → open, audited, dates in yyyy-MM-dd (L2-03, L6-11)', () => {
    // The driver hands closes_at back as a JS Date. String(date).slice(0, 10)
    // used to put "Sat Oct 31" into the FR audit line — an English weekday.
    const lockedCycle = {
        id: 9,
        code: '2026-Q3',
        status: 'locked',
        closesAt: new Date('2026-08-31T00:00:00.000Z'),
    };

    test('writes the new deadline and names the previous one as a date', async () => {
        mockDb.get.mockResolvedValue(lockedCycle);
        mockDb.all.mockResolvedValue([]);
        const r = await CycleService.reopen(9, '2026-10-31', SUPER);

        expect(r).toMatchObject({ reopened: true, closesAt: '2026-10-31' });
        const sql = mockDb.run.mock.calls.map((c) => String(c[0])).join(' ');
        expect(sql).toMatch(/UPDATE assessment_cycles[\s\S]*status\s*=\s*'open'/);
        expect(sql).toMatch(/reopen_count\s*=\s*reopen_count\s*\+\s*1/);

        const a = auditFor('cycle_reopened');
        expect(a.details).toContain('nouvelle échéance 2026-10-31');
        expect(a.details).toContain('(précédente 2026-08-31)');
        expect(a.details).not.toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/);
    });

    test('refuses a cycle that is not locked, a missing date and a date in the past', async () => {
        mockDb.get.mockResolvedValue({ ...lockedCycle, status: 'open' });
        await expect(CycleService.reopen(9, '2026-10-31', SUPER)).rejects.toThrow(
            'cycle_not_locked'
        );
        mockDb.get.mockResolvedValue(lockedCycle);
        await expect(CycleService.reopen(9, '', SUPER)).rejects.toThrow('cycle_dates_required');
        await expect(CycleService.reopen(9, '2020-01-01', SUPER)).rejects.toThrow(
            'cycle_deadline_past'
        );
    });
});

describe('extendDeadline — open only, same date discipline (L2-27)', () => {
    test('moves the deadline and audits both dates', async () => {
        mockDb.get.mockResolvedValue({
            id: 9,
            code: '2026-Q3',
            status: 'open',
            closesAt: new Date('2026-10-31T00:00:00.000Z'),
        });
        const r = await CycleService.extendDeadline(9, '2026-11-15', SUPER);
        expect(r).toMatchObject({ extended: true, closesAt: '2026-11-15' });
        const a = auditFor('cycle_deadline_extended');
        expect(a.details).toContain('déplacée au 2026-11-15');
        expect(a.details).toContain('(précédente 2026-10-31)');
    });
    test('refuses a locked cycle', async () => {
        mockDb.get.mockResolvedValue({ id: 9, status: 'locked' });
        await expect(CycleService.extendDeadline(9, '2026-11-15', SUPER)).rejects.toThrow(
            'cycle_not_open'
        );
    });
});

describe('cancel — a draft becomes cancelled with a mandatory reason, never deleted (L2-26)', () => {
    test('an empty reason is refused', async () => {
        mockDb.get.mockResolvedValue({ id: 13, code: 'UAT', status: 'draft' });
        await expect(CycleService.cancel(13, '   ', SUPER)).rejects.toThrow(/reason/i);
    });
    test('a running campaign cannot be cancelled', async () => {
        mockDb.get.mockResolvedValue({ id: 9, code: '2026-Q3', status: 'locked' });
        await expect(CycleService.cancel(9, 'doublon', SUPER)).rejects.toThrow('cycle_not_draft');
    });
    test('a draft flips state and keeps the reason — no DELETE is emitted', async () => {
        mockDb.get.mockResolvedValue({ id: 13, code: 'UAT', status: 'draft' });
        await CycleService.cancel(13, 'Doublon UAT', SUPER);
        const sql = mockDb.run.mock.calls.map((c) => String(c[0])).join(' ');
        expect(sql).toMatch(/UPDATE assessment_cycles/);
        expect(sql).not.toMatch(/DELETE\s+FROM\s+assessment_cycles/i);
        expect(auditFor('cycle_cancelled').details).toContain('Doublon UAT');
    });
});

describe('create — code and dates validated before anything is written (L2-18)', () => {
    test('a bad code, a missing date and closes < opens are all refused', async () => {
        mockDb.get.mockResolvedValue(null);
        await expect(
            CycleService.create({ code: '', opensAt: '2026-10-01', closesAt: '2026-10-31' })
        ).rejects.toThrow('cycle_code_required');
        await expect(
            CycleService.create({ code: 'ZZ TEST!', opensAt: '2026-10-01', closesAt: '2026-10-31' })
        ).rejects.toThrow('cycle_code_invalid');
        await expect(
            CycleService.create({ code: 'ZZ-OK', opensAt: '', closesAt: '2026-10-31' })
        ).rejects.toThrow('cycle_dates_required');
        await expect(
            CycleService.create({ code: 'ZZ-OK', opensAt: '2026-10-01', closesAt: '2026-09-01' })
        ).rejects.toThrow('cycle_dates_invalid');
    });
    test('a duplicate code is refused case-insensitively', async () => {
        mockDb.get.mockResolvedValue({ id: 9 });
        await expect(
            CycleService.create({ code: '2026-q3', opensAt: '2026-10-01', closesAt: '2026-10-31' })
        ).rejects.toThrow('cycle_code_taken');
    });
});

describe('excludeBulk — one request, one audit row per person, category + reason (L2-02/10/29)', () => {
    const RUNNING_CYCLE = { id: 9, code: '2026-Q3', status: 'open' };

    test('an unknown category is refused before any write', async () => {
        mockDb.get.mockResolvedValue(RUNNING_CYCLE);
        await expect(
            CycleService.excludeBulk(
                9,
                { employeeIds: [96] },
                { reason: 'x', category: 'whatever' },
                SUPER
            )
        ).rejects.toThrow(/category/);
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('an empty reason is refused', async () => {
        mockDb.get.mockResolvedValue(RUNNING_CYCLE);
        await expect(
            CycleService.excludeBulk(
                9,
                { employeeIds: [96] },
                { reason: '  ', category: 'other' },
                SUPER
            )
        ).rejects.toThrow(/reason/i);
    });

    test('a system category may not be chosen by a human — reconcile writes those', async () => {
        mockDb.get.mockResolvedValue(RUNNING_CYCLE);
        await expect(
            CycleService.excludeBulk(
                9,
                { employeeIds: [96] },
                { reason: 'x', category: 'deactivated' },
                SUPER
            )
        ).rejects.toThrow(/category/);
        await expect(
            CycleService.excludeBulk(
                9,
                { employeeIds: [96] },
                { reason: 'x', category: 'erased' },
                SUPER
            )
        ).rejects.toThrow(/category/);
    });

    test('the selection runs in ONE transaction and audits each person once, with actor and category', async () => {
        mockDb.get.mockResolvedValue(RUNNING_CYCLE);
        // db.all in order: _rosterIdsInScope → the UPDATE … RETURNING → _names.
        mockDb.all
            .mockResolvedValueOnce([
                { employeeId: '96' },
                { employeeId: '97' },
                { employeeId: '99' },
            ])
            .mockResolvedValueOnce([
                { employeeId: '96' },
                { employeeId: '97' },
                { employeeId: '99' },
            ])
            .mockResolvedValue([
                { id: '96', firstName: 'Ingrid', lastName: 'Berg' },
                { id: '97', firstName: 'A', lastName: 'B' },
                { id: '99', firstName: 'C', lastName: 'D' },
            ]);

        const r = await CycleService.excludeBulk(
            9,
            { employeeIds: [96, 97, 99] },
            { reason: 'Rotation site', category: 'long_leave', until: '2026-12-31' },
            SUPER
        );

        expect(r).toMatchObject({ requested: 3, changed: 3, alreadyExcluded: 0, outOfScope: 0 });
        expect(mockDb.runTransaction).toHaveBeenCalledTimes(1);

        const excluded = mockLog.mock.calls
            .map((c) => c[0])
            .filter((a) => a.action === 'cycle_participant_excluded');
        expect(excluded).toHaveLength(3);
        excluded.forEach((a) => {
            expect(a.details).toContain('absence longue durée'); // the FR label of long_leave
            expect(a.details).toContain('Rotation site');
            expect(a.details).toContain("jusqu'au 2026-12-31");
            expect(a.details).toContain('par admin admin'); // actor named on every row
        });

        // ONE statement excuses the whole selection (RETURNING drives the audit loop).
        const update = mockDb.all.mock.calls
            .map((c) => String(c[0]))
            .find((s) => /UPDATE cycle_participants/.test(s));
        expect(update).toMatch(/excluded_by_admin_id/);
        expect(update).toMatch(/exclusion_category/);
        expect(update).toMatch(/excluded_until/);
        expect(update).toMatch(/RETURNING/);
        expect(update).toMatch(/excluded_at IS NULL/); // already-excused rows are not re-stamped
        const allSql = mockDb.all.mock.calls
            .concat(mockDb.run.mock.calls)
            .map((c) => String(c[0]))
            .join(' ');
        expect(allSql).not.toMatch(/DELETE\s+FROM\s+cycle_participants/i);
    });

    test('ids outside the actor scope are reported, never silently excused', async () => {
        mockDb.get.mockResolvedValue(RUNNING_CYCLE);
        mockDb.all.mockResolvedValueOnce([]).mockResolvedValue([]); // nothing in scope
        const scoped = {
            userType: 'admin',
            role: 'localadmin',
            id: 631,
            username: 'qa.local',
            permissions: ['manage_cycles'],
        };
        const r = await CycleService.excludeBulk(
            9,
            { employeeIds: [96, 97] },
            { reason: 'x', category: 'other' },
            scoped
        );
        expect(r).toMatchObject({ requested: 2, changed: 0, outOfScope: 2 });
        expect(
            mockLog.mock.calls.filter((c) => c[0].action === 'cycle_participant_excluded')
        ).toHaveLength(0);
    });

    // SECTION campaign-rules / A5: the refusal now goes through the campaign write gate, so the
    // code is state-specific and the message NAMES the campaign and its closing date
    // instead of the bare `cycle_not_running`.
    test('a closed campaign refuses the whole operation, naming the campaign and its closing date', async () => {
        mockDb.get.mockResolvedValue({
            id: 2,
            code: 'UAT',
            status: 'closed',
            closedAt: new Date('2026-09-01T00:00:00Z'),
        });
        const e = await CycleService.excludeBulk(
            2,
            { employeeIds: [138] },
            { reason: 'x', category: 'other' },
            SUPER
        ).catch((x) => x);
        expect(e.code).toBe('cycle_write_closed');
        expect(e.message).toContain('UAT');
        // CLÔTURE UAT3 : la date est NOMMÉE, dans la graphie du lecteur (classe E-13).
        expect(e.message).toContain('01/09/2026');
    });
});

describe('includeParticipant — re-inclusion keeps the history row (L2-10)', () => {
    // db.get in order: findById (_assertRunning) → _rosterInScope → the current row.
    test('the UPDATE moves the exclusion into last_* instead of erasing it', async () => {
        mockDb.get
            .mockResolvedValueOnce({ id: 9, code: '2026-Q3', status: 'open' })
            .mockResolvedValueOnce({ ok: 1 })
            .mockResolvedValue({ category: 'long_leave', isActive: true, erasedAt: null });
        mockDb.run.mockResolvedValue({ changes: 1 });
        mockDb.all.mockResolvedValue([{ id: '96', firstName: 'Ingrid', lastName: 'Berg' }]);
        const r = await CycleService.includeParticipant(9, 96, SUPER);
        expect(r).toMatchObject({ changed: 1 });
        const sql = mockDb.run.mock.calls.map((c) => String(c[0])).join(' ');
        expect(sql).toMatch(/last_excluded_at\s*=\s*excluded_at/);
        expect(sql).toMatch(/last_exclusion_category\s*=\s*exclusion_category/);
        expect(sql).toMatch(/last_excluded_by_admin_id\s*=\s*excluded_by_admin_id/);
        expect(sql).toMatch(/included_at\s*=\s*now\(\)/);
        expect(sql).toMatch(/included_by_admin_id\s*=/);
        expect(auditFor('cycle_participant_included').details).toContain('réintégré(e)');
    });
    test('an erased subject can never be put back on a roster (L2-07)', async () => {
        mockDb.get
            .mockResolvedValueOnce({ id: 9, code: '2026-Q3', status: 'open' })
            .mockResolvedValueOnce({ ok: 1 })
            .mockResolvedValue({ category: 'erased', isActive: false, erasedAt: '2026-09-01' });
        await expect(CycleService.includeParticipant(9, 68963, SUPER)).rejects.toThrow(
            'participant_erased'
        );
        expect(mockDb.run).not.toHaveBeenCalled();
    });
    test('a deactivated subject is refused until they are reactivated', async () => {
        mockDb.get
            .mockResolvedValueOnce({ id: 9, code: '2026-Q3', status: 'open' })
            .mockResolvedValueOnce({ ok: 1 })
            .mockResolvedValue({ category: 'deactivated', isActive: false, erasedAt: null });
        await expect(CycleService.includeParticipant(9, 285, SUPER)).rejects.toThrow(
            'participant_inactive'
        );
    });
    test('a person outside the actor clearance is refused', async () => {
        mockDb.get
            .mockResolvedValueOnce({ id: 9, code: '2026-Q3', status: 'open' })
            .mockResolvedValue(null);
        await expect(CycleService.includeParticipant(9, 90, SUPER)).rejects.toThrow(
            'participant_not_in_scope'
        );
    });
});

describe('reconcileParticipants — honest roster on open AND locked (L2-07/12, L5C-04)', () => {
    test('a closed campaign is skipped, not reconciled', async () => {
        mockDb.get.mockResolvedValue({ id: 2, code: 'UAT', status: 'closed' });
        const r = await CycleService.reconcileParticipants(2);
        expect(r).toMatchObject({ skipped: 'cycle_not_running' });
    });
    test('a locked campaign still auto-excuses, so a close never counts a ghost', async () => {
        mockDb.get.mockResolvedValue({ id: 9, code: '2026-Q3', status: 'locked' });
        mockDb.all.mockResolvedValue([]);
        mockDb.run.mockResolvedValue({ changes: 0 });
        const r = await CycleService.reconcileParticipants(9);
        expect(r.skipped).toBeUndefined();
        const sql = mockDb.run.mock.calls
            .concat(mockDb.all.mock.calls)
            .map((c) => String(c[0]))
            .join(' ');
        expect(sql).toMatch(/erased/);
        expect(sql).toMatch(/deactivated/);
    });
    test('enrolment of joiners is reserved to an OPEN campaign', async () => {
        mockDb.get.mockResolvedValue({ id: 9, code: '2026-Q3', status: 'locked' });
        mockDb.all.mockResolvedValue([]);
        const r = await CycleService.reconcileParticipants(9);
        expect(r.added).toBe(0);
    });
});

describe('nudge — claim before send, span-limited, never on a locked campaign (L5A-01/16)', () => {
    const OPEN = {
        id: 9,
        code: '2026-Q3',
        status: 'open',
        closesAt: new Date('2026-10-31T00:00:00.000Z'),
    };
    const targets = [
        {
            employeeId: '140',
            state: 'not_started',
            expected: 12,
            firstName: 'A',
            reviewerId: '136',
            reviewerAdminId: null,
        },
        {
            employeeId: '144',
            state: 'not_started',
            expected: 13,
            firstName: 'B',
            reviewerId: '136',
            reviewerAdminId: null,
        },
    ];

    test('sends one notification per person and claims each one first', async () => {
        mockDb.get.mockResolvedValue(OPEN);
        mockDb.all.mockResolvedValue(targets);
        const r = await CycleService.nudge(9, { all: true, states: ['not_started'] }, MANAGER);
        expect(r).toMatchObject({ targets: 2, sent: 2, alreadyToday: 0, lockedSkipped: 0 });
        expect(mockClaim).toHaveBeenCalledTimes(2);
        expect(mockNotify).toHaveBeenCalledTimes(2);
        // The payload carries a real date, not a weekday (L6-11).
        mockNotify.mock.calls.forEach(([n]) => {
            expect(n.kind).toBe('cycle.reminder');
            expect(n.payload.closesOn).toBe('2026-10-31');
        });
    });

    test('a second click the same day sends nothing — the claim is already held', async () => {
        mockDb.get.mockResolvedValue(OPEN);
        mockDb.all.mockResolvedValue(targets);
        mockClaim.mockResolvedValue(false);
        const r = await CycleService.nudge(9, { all: true, states: ['not_started'] }, MANAGER);
        expect(r).toMatchObject({ targets: 2, sent: 0, alreadyToday: 2 });
        expect(mockNotify).not.toHaveBeenCalled();
    });

    test('a failed send releases its claim so tomorrow can retry', async () => {
        mockDb.get.mockResolvedValue(OPEN);
        mockDb.all.mockResolvedValue([targets[0]]);
        mockNotify.mockResolvedValue({ inapp: 'error' });
        const r = await CycleService.nudge(9, { all: true }, MANAGER);
        expect(r.sent).toBe(0);
        expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    test('on a LOCKED campaign employees are skipped with a reason, not chased', async () => {
        mockDb.get.mockResolvedValue({ ...OPEN, status: 'locked' });
        mockDb.all.mockResolvedValue(targets);
        const r = await CycleService.nudge(9, { all: true }, MANAGER);
        expect(r).toMatchObject({ sent: 0, lockedSkipped: 2 });
        expect(mockNotify).not.toHaveBeenCalled();
        expect(auditFor('cycle_manual_nudge').details).toContain('campagne verrouillée');
    });

    test('the roster query is scoped and never lists an erased subject', async () => {
        mockDb.get.mockResolvedValue(OPEN);
        mockDb.all.mockResolvedValue([]);
        await CycleService.nudge(9, { all: true }, MANAGER);
        const sql = String(mockDb.all.mock.calls.pop()[0]);
        expect(sql).toMatch(/e\.erased_at IS NULL/);
        expect(sql).toMatch(/v\.excluded_at IS NULL/);
    });

    test('an empty explicit selection is refused rather than fanning out to everyone', async () => {
        mockDb.get.mockResolvedValue(OPEN);
        await expect(CycleService.nudge(9, { employeeIds: [] }, MANAGER)).rejects.toThrow(
            'nudge_selection_empty'
        );
    });

    // SECTION campaign-rules / A5: same gate, same named refusal (see excludeBulk above).
    test('a closed campaign refuses the chase, naming the campaign', async () => {
        mockDb.get.mockResolvedValue({
            id: 2,
            code: 'UAT',
            status: 'closed',
            closedAt: new Date('2026-09-01T00:00:00Z'),
        });
        const e = await CycleService.nudge(2, { all: true }, MANAGER).catch((x) => x);
        expect(e.code).toBe('cycle_write_closed');
        expect(e.message).toContain('UAT');
    });
});

describe('participants — roster reads stay honest (L2-01/07/25)', () => {
    test('the sort key is resolved through a whitelist, never interpolated', async () => {
        mockDb.get.mockResolvedValue({ id: 9, code: '2026-Q3', status: 'locked' });
        mockDb.all.mockResolvedValue([]);
        mockDb.get.mockResolvedValue({ n: 0, total: 0 });
        await CycleService.participants(9, SUPER, {
            sort: 'DROP TABLE employees',
            dir: 'desc',
            limit: 10,
            scope: { clause: '', params: [] },
        });
        const sql = mockDb.all.mock.calls.map((c) => String(c[0])).join(' ');
        expect(sql).not.toMatch(/DROP TABLE/i);
    });
    test('erased subjects are filtered out of every roster read', async () => {
        mockDb.all.mockResolvedValue([]);
        mockDb.get.mockResolvedValue({ n: 0, total: 0 });
        await CycleService.participants(9, SUPER, { limit: 10, scope: { clause: '', params: [] } });
        const sql = mockDb.all.mock.calls.map((c) => String(c[0])).join(' ');
        expect(sql).toMatch(/erased_at IS NULL/);
    });
});
