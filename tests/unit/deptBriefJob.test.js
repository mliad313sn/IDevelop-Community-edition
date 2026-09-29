'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * DEPARTMENT BRIEF — the JOB: schedule, exactly-once ledger, cadence merge,
 * daily cap, supersede, rendering and delivery.
 *
 * Every assertion here exists because a LIVE defect in this repository already
 * got the same thing wrong:
 *
 *   - manager-digest.js:39-44 gates on an App-Settings marker (read, then write,
 *     no lock) and planning-digest.js:205 on a strict `getDate() !== dom` — the
 *     first double-sends under two instances, the second skips the send for good
 *     when the machine was off on the due day (for the yearly cadence: a year);
 *   - dept-digest.js:231-236 CLAIMS, then computes, then `if (!rows.length)
 *     continue;` — a momentarily empty scope burns a month with no send and no
 *     release;
 *   - reminders.js:98-100 treats `{ inapp:'error', email:'sent' }` as a failure,
 *     which would release the claim and re-send the same brief every hour;
 *   - manager-digest, dept-digest and planning-digest all hand
 *     NotificationService a COMPLETE emailTemplate.wrap() document, which
 *     _render() then wraps again in _shell();
 *   - HealthController.js:89 counted 'EMAIL_SEND_FAILED', a string that exists
 *     nowhere in src/, so the SMTP failure counter read 0 whatever happened;
 *   - sendDigest() re-listed every unread notification EVERY day, and 259 of the
 *     262 rows on the development database are unread.
 *
 * Measured on idevelop while writing this: 20 governors, 19 with a usable account
 * (employee 137 governs 16 people and has no login), 14 active admins, one of
 * them (test.viewer #70) with no live scope at all, 76 active employees.
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Mocks. Names are `mock`-prefixed so jest.mock's factory may close over them.
// ---------------------------------------------------------------------------

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(async () => ({ changes: 0 })),
    runTransaction: jest.fn(async (fn) => fn()),
    runInSavepoint: jest.fn(async (fn) => fn()),
    inTransaction: jest.fn(() => false),
};
jest.mock('../../src/config/database', () => mockDb);

const mockService = {
    scopeOf: jest.fn(),
    buildPayload: jest.fn(),
    scopeSignature: jest.fn(() => 'sig'),
    // A-07 — le titre d'une ligne de flux est recalculé AU RENDU (page ET
    // e-mail) à partir de son `metric`, parce qu'un bilan archivé a figé
    // « self_assessment ouverts ». Le vrai comportement est vérifié dans
    // lotA-dept-brief-uat3 ; ici on rend le service, donc on rend la fonction.
    resolveFlowTitle: jest.fn((line) => {
        const m = String((line && line.metric) || '');
        if (!m.startsWith('opened.')) return line.title;
        const t = m.slice('opened.'.length);
        return t === 'self_assessment'
            ? { fr: 'Auto-évaluations ouvertes', en: 'Self-assessments opened' }
            : line.title;
    }),
    // M-08 — le RENVOI passe par la même réparation au rendu que la page (un
    // âge négatif archivé n'est pas republié). Même raison que `resolveFlowTitle`
    // ci-dessus : on rend le service, donc on rend la fonction — mais ici la
    // VRAIE, parce qu'elle est pure et que le renvoi doit rester octet pour
    // octet identique d'un rejeu à l'autre. Comportement vérifié dans
    // s8-frozen-age-uat3.
    repairFrozenPayload: jest.fn((p) =>
        jest.requireActual('../../src/services/DeptBriefService').repairFrozenPayload(p)
    ),
};
jest.mock('../../src/services/DeptBriefService', () => mockService);

const mockNotify = {
    notify: jest.fn(async () => ({ inapp: 'queued', email: 'sent' })),
    enqueue: jest.fn(async () => ({ state: 'queued' })),
};
jest.mock('../../src/services/NotificationService', () => mockNotify);

const mockEmail = { isCategoryEnabled: jest.fn(async () => true) };
jest.mock('../../src/services/EmailService', () => mockEmail);

const mockAccounts = { accountsWithEmail: jest.fn(async () => []) };
jest.mock('../../src/services/EmailAccountsService', () => mockAccounts);

const mockSettings = { getValue: jest.fn(async (k, d) => d), setValue: jest.fn(async () => {}) };
jest.mock('../../src/models/AppSettingsModel', () => mockSettings);

const mockReminders = {
    claim: jest.fn(async () => true),
    release: jest.fn(async () => {}),
};
// The ledger PRIMITIVES are mocked; the period BUCKETS are the real ones —
// utils/periodWindow deliberately reads them from this module rather than
// forking a second week bucket the way cycle-nudge.js:123-128 did.
jest.mock('../../src/jobs/reminders', () => ({
    ...jest.requireActual('../../src/jobs/reminders'),
    ...mockReminders,
}));

const mockJobRun = { alert: jest.fn(async () => 1) };
jest.mock('../../src/services/JobRunService', () => mockJobRun);

jest.mock('../../src/utils/branding', () => ({
    getBranding: async () => ({ appName: 'ACME', accentColor: '#123456' }),
}));

const job = require('../../src/jobs/dept-brief');
const { renderBlocks, gateFor, recipients, landed, defaultEnabled } = job.__test;
const JOB_SRC = fs.readFileSync(path.join(__dirname, '../../src/jobs/dept-brief.js'), 'utf8');

// ---------------------------------------------------------------------------
// A tiny SQL router: the tick issues a fixed set of query shapes.
// ---------------------------------------------------------------------------

const state = {
    claims: [], // rows accepted by the dept_briefs UNIQUE
    conflicts: new Set(), // "cadence|period|type|id" already held by somebody
    deletes: [],
    updates: [],
    governors: [{ id: 85, firstName: 'A', email: null, username: 'a', accountActive: true }],
    admins: [],
    linked: [],
    prefs: [],
};

function resetState(over = {}) {
    state.claims = [];
    state.conflicts = new Set();
    state.deletes = [];
    state.updates = [];
    state.governors = [{ id: 85, firstName: 'A', email: null, username: 'a', accountActive: true }];
    state.admins = [];
    state.linked = [];
    state.prefs = [];
    Object.assign(state, over);
}

let nextId = 1;

function wireDb() {
    mockDb.get.mockImplementation(async (sql, params = []) => {
        if (/INSERT INTO dept_briefs/i.test(sql)) {
            const [cadence, period, type, id] = params;
            const key = `${cadence}|${period}|${type}|${id}`;
            if (state.conflicts.has(key)) return undefined; // ON CONFLICT DO NOTHING
            state.conflicts.add(key);
            const row = {
                id: nextId++,
                cadence,
                period,
                type,
                recipientId: Number(id),
                payload: params[9],
            };
            state.claims.push(row);
            return { id: row.id };
        }
        if (/UPDATE dept_briefs SET payload = \?, computed_at/i.test(sql)) {
            state.updates.push({ forced: true, sql });
            return { id: 4242 };
        }
        if (/FROM dept_briefs\s+WHERE cadence/i.test(sql)) return state.archived || undefined;
        if (/FROM employees WHERE is_active/i.test(sql)) return { n: 76 };
        if (/FROM notifications/i.test(sql)) return { read: 0, n: 0 };
        if (/MIN\(occurred_at\)/i.test(sql)) return { m: '2026-06-01T00:00:00Z' };
        return undefined;
    });
    mockDb.all.mockImplementation(async (sql) => {
        if (/linked_employee_id IS NOT NULL/i.test(sql)) return state.linked;
        if (/FROM employees m/i.test(sql)) return state.governors;
        if (/FROM admins WHERE is_active/i.test(sql)) return state.admins;
        if (/FROM dept_brief_prefs/i.test(sql)) return state.prefs;
        return [];
    });
    mockDb.run.mockImplementation(async (sql, params = []) => {
        if (/DELETE FROM dept_briefs/i.test(sql)) {
            state.deletes.push(Number(params[0]));
            return { changes: 1 };
        }
        state.updates.push({ sql, params });
        if (/UPDATE notifications SET read_at/i.test(sql))
            return { changes: state.superseded || 0 };
        return { changes: 1 };
    });
}

/** A payload shaped exactly like DeptBriefService.buildPayload's. */
function payload({ isEmpty = false, period = '2026-08', cadence = 'monthly' } = {}) {
    const cell = (value, text, extra = {}) => ({
        value,
        text: { fr: text, en: text },
        state: value === null ? 'unmeasured' : value === 0 ? 'zero' : 'measured',
        color: null,
        ...extra,
    });
    return {
        version: 1,
        cadence,
        period,
        periodStart: new Date(Date.UTC(2026, 7, 1)),
        periodEnd: new Date(Date.UTC(2026, 8, 1)),
        displayEnd: new Date(Date.UTC(2026, 7, 31)),
        days: 31,
        horizonDays: 30,
        computedAt: new Date(Date.UTC(2026, 8, 1, 7)),
        scopeSignature: 'sig',
        scopeSize: 5,
        recipient: { type: 'admin', id: 3 },
        units: [
            {
                unitId: 11,
                unitName: 'Riverside / IT',
                headcount: 5,
                totalHeadcount: 36,
                withoutRequirements: 0,
                label: {
                    fr: 'Riverside / IT — votre périmètre : 5 personnes sur 36',
                    en: 'Riverside / IT — your scope: 5 of 36 people',
                },
            },
        ],
        blocks: {
            A: isEmpty
                ? []
                : [
                      {
                          id: 'A1',
                          severity: 'action',
                          title: {
                              fr: 'Auto-évaluations à valider',
                              en: 'Self-assessments to review',
                          },
                          lines: [
                              {
                                  unitId: 11,
                                  label: { fr: 'Riverside / IT', en: 'Riverside / IT' },
                                  count: cell(3, '3'),
                                  oldestAge: cell(9, '9 jours'),
                                  overdue: true,
                              },
                          ],
                          source: 'self_assessments',
                          rule: { fr: 'r', en: 'r' },
                          link: '/x',
                      },
                  ],
            B: [],
            C: [],
        },
        footer: {
            units: [
                {
                    unitId: 11,
                    label: { fr: 'Riverside / IT', en: 'Riverside / IT' },
                    headcount: 5,
                    withoutRequirements: 0,
                    d1Coverage: cell(null, '—'),
                    d2Readiness: cell(null, '—'),
                    d3Completion: cell(null, '—'),
                    d3Met: cell(null, '—'),
                    d4Critical: cell(null, '—'),
                    d5MeasuredPeople: cell(0, '0/5'),
                },
            ],
            totals: {
                headcount: 5,
                contributingDepartments: 0,
                departments: 1,
                coverage: cell(null, '—'),
                completion: cell(null, '—'),
                measuredPeople: cell(0, '0/5'),
                _raw: {},
            },
        },
        flow: {
            window: {
                start: null,
                end: null,
                days: 31,
                prevStart: null,
                prevEnd: null,
                prevDays: 31,
                sameLength: true,
            },
            lines: [
                {
                    metric: 'reviewsClosed',
                    title: { fr: 'Revues clôturées', en: 'Reviews closed' },
                    table: 't',
                    now: 4,
                    before: 2,
                    importBatch: null,
                    value: cell(4, '4'),
                    delta: { state: 'value', value: 2, pct: 100, color: '#15803d' },
                },
            ],
            assessmentsRecorded: cell(null, '—', {
                rule: { fr: 'historisation partielle', en: 'partial history' },
            }),
        },
        deltas: {
            basis: 'comparable',
            seriesStart: new Date(Date.UTC(2026, 6, 1)),
            d1: null,
            d5: null,
        },
        isEmpty,
        disclaimer: {
            fr: 'Les chiffres non mesurés sont affichés « — »',
            en: 'Unmeasured figures are shown as "—"',
        },
        natureOfFigures: { fr: 'A = …', en: 'A = …' },
    };
}

const SETTINGS = {
    deptBriefWeeklyEnabled: 'true',
    deptBriefMonthlyEnabled: 'true',
    deptBriefQuarterlyEnabled: 'true',
    deptBriefYearlyEnabled: 'true',
    deptBriefYearlySendEmpty: 'true',
    deptBriefHour: '7',
    deptBriefWeeklyDow: '1',
    deptBriefMonthlyDom: '1',
    deptBriefQuarterlyDom: '1',
    deptBriefYearlyDom: '1',
    deptBriefMaxLines: '7',
    deptBriefReadRateFloorPct: '20',
};

beforeEach(() => {
    jest.clearAllMocks();
    resetState();
    wireDb();
    nextId = 1;
    mockSettings.getValue.mockImplementation(async (k, d) => (k in SETTINGS ? SETTINGS[k] : d));
    mockSettings.setValue.mockImplementation(async () => {});
    mockService.scopeOf.mockImplementation(async (r) => ({
        type: r.type,
        id: r.id,
        ids: [1, 2, 3, 4, 5],
        unrestricted: false,
        size: 5,
    }));
    mockService.buildPayload.mockImplementation(async (r, cadence, win) =>
        payload({ cadence, period: win.bucket })
    );
    mockNotify.notify.mockImplementation(async () => ({ inapp: 'queued', email: 'sent' }));
    mockNotify.enqueue.mockImplementation(async () => ({ state: 'queued' }));
    mockReminders.claim.mockImplementation(async () => true);
    mockEmail.isCategoryEnabled.mockImplementation(async () => true);
    mockAccounts.accountsWithEmail.mockImplementation(async () => []);
});

afterEach(() => {
    jest.useRealTimers();
});

const SET = {
    enabled: { weekly: true, monthly: true, quarterly: true, yearly: true },
    hour: 7,
    weeklyDow: 1,
    dom: { monthly: 1, quarterly: 1, yearly: 1 },
    maxLines: 7,
    readRateFloorPct: 20,
    yearlySendEmpty: true,
};
const ADMIN = { type: 'admin', id: 3, role: 'localadmin' };
const EMP = { type: 'employee', id: 85 };

// ===========================================================================
describe('the tick is registered and the boot cannot break', () => {
    test('TICKS carries dept-brief.tick with the five mandatory fields', () => {
        const { TICKS } = require('../../src/jobs');
        const t = TICKS.find((x) => x.name === 'dept-brief.tick');
        expect(t).toBeTruthy();
        expect({ cron: t.cron, everyMin: t.everyMin, keep: t.keep, bootRun: t.bootRun }).toEqual({
            cron: '22 * * * *',
            everyMin: 60,
            keep: 30,
            bootRun: true,
        });
        expect(typeof t.fn).toBe('function');
    });

    test('it fires BEFORE personal-digest — whose claim is per DAY', () => {
        const { TICKS } = require('../../src/jobs');
        const minute = (name) => Number(/^(\d+) /.exec(TICKS.find((x) => x.name === name).cron)[1]);
        // A notification written after personal-digest's minute cannot be
        // e-mailed before tomorrow.
        expect(minute('dept-brief.tick')).toBeLessThan(minute('personal-digest.tick'));
    });

    test('it is NOT a DAILY_TICK — a monthly cadence would alert every day', () => {
        // STALE_AFTER_MS is 36 h; a cadence that is monthly or yearly by design
        // would raise ops.job_failed to every SuperAdmin daily and wear a
        // permanent "stale" badge.
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/services/JobRunService.js'),
            'utf8'
        );
        const line = /const DAILY_TICKS = \[([^\]]*)\]/.exec(src)[1];
        expect(line).not.toContain('dept-brief');
    });

    test('the orphan-run reaper exists and closes runs left open by a kill', async () => {
        const jobs = require('../../src/jobs');
        expect(typeof jobs.reapOrphanRuns).toBe('function');
        const calls = [];
        mockDb.run.mockImplementationOnce(async (sql) => {
            calls.push(sql);
            return { changes: 2 };
        });
        const n = await jobs.reapOrphanRuns();
        expect(n).toBe(2);
        // Without it, /admin/health reads `running: !!(last && !last.finishedAt)`
        // and shows the tick as running for ever.
        expect(calls[0]).toMatch(/UPDATE job_runs SET finished_at = now\(\), ok = false/);
        expect(calls[0]).toMatch(/finished_at IS NULL/);
        expect(calls[0]).toMatch(/interval '2 hours'/);
    });
});

// ===========================================================================
describe('the gate — the ledger decides, not the calendar', () => {
    const monday = new Date(Date.UTC(2026, 8, 7, 8)); // Monday 07/09/2026, 08:00 UTC

    test('a closed week is due at/after the hour, and NOT before', () => {
        const early = gateFor('weekly', new Date(Date.UTC(2026, 8, 7, 6, 59)), {
            settings: SET,
            recipient: ADMIN,
        });
        expect(early.due).toBe(false);
        expect(early.reason).toBe('not_due');
        const due = gateFor('weekly', monday, { settings: SET, recipient: ADMIN });
        expect(due.due).toBe(true);
        expect(due.bucket).toBe('2026-W36');
    });

    test('a machine that was off still sends inside the catch-up window', () => {
        // Wednesday: the Monday send was missed. The gate is `>=`, never `===`.
        const wed = gateFor('weekly', new Date(Date.UTC(2026, 8, 9, 8)), {
            settings: SET,
            recipient: ADMIN,
        });
        expect(wed.due).toBe(true);
        expect(wed.bucket).toBe('2026-W36');
    });

    test('beyond the catch-up window it is too_late — a fresh install never back-fills', () => {
        const late = gateFor('quarterly', new Date(Date.UTC(2026, 8, 13, 8)), {
            settings: SET,
            recipient: ADMIN,
        });
        expect(late.due).toBe(false);
        expect(late.reason).toBe('too_late');
    });

    test('a disabled cadence is refused before anything else', () => {
        const off = gateFor('monthly', monday, {
            settings: { ...SET, enabled: { ...SET.enabled, monthly: false } },
            recipient: ADMIN,
        });
        expect(off).toMatchObject({ due: false, reason: 'disabled' });
    });

    test('weekly defaults: OFF for an employee (manager-digest covers it), ON for a scoped admin, OFF for a SuperAdmin', () => {
        expect(defaultEnabled('weekly', EMP)).toBe(false);
        expect(defaultEnabled('weekly', ADMIN)).toBe(true);
        expect(defaultEnabled('weekly', { type: 'admin', id: 1, role: 'superadmin' })).toBe(false);
        // Every other cadence is on by default for everybody.
        for (const c of ['monthly', 'quarterly', 'yearly']) {
            expect(defaultEnabled(c, EMP)).toBe(true);
            expect(defaultEnabled(c, ADMIN)).toBe(true);
        }
    });

    test('an employee weekly brief is refused with its OWN reason, not a generic one', () => {
        const g = gateFor('weekly', monday, { settings: SET, recipient: EMP });
        expect(g).toMatchObject({ due: false, reason: 'covered_by_manager_digest' });
    });

    test('an explicit preference beats the default, both ways', () => {
        expect(
            gateFor('weekly', monday, { settings: SET, prefs: { weekly: true }, recipient: EMP })
                .due
        ).toBe(true);
        expect(
            gateFor('weekly', monday, { settings: SET, prefs: { weekly: false }, recipient: ADMIN })
        ).toMatchObject({ due: false, reason: 'pref_off' });
    });

    test('the whole gate is UTC — the same instant gates the same way in any zone', () => {
        const iso = '2026-09-07T08:00:00.000Z';
        const a = gateFor('weekly', new Date(iso), { settings: SET, recipient: ADMIN });
        const b = gateFor('weekly', new Date(Date.parse(iso)), { settings: SET, recipient: ADMIN });
        expect(a.bucket).toBe(b.bucket);
        expect(a.periodStart).toEqual(b.periodStart);
        expect(a.win.periodEnd.toISOString()).toBe('2026-09-07T00:00:00.000Z');
    });
});

// ===========================================================================
describe('recipients', () => {
    test('a governor without a usable login is EXCLUDED but REPORTED', async () => {
        // Measured on idevelop: employee 137 governs 16 people and their login was
        // stripped. A 16-person scope with no reachable owner is a governance
        // hole, so it is published rather than silently dropped.
        state.governors = [
            { id: 85, firstName: 'A', username: 'a', accountActive: true, email: null },
            { id: 137, firstName: 'M', username: null, accountActive: false, email: null },
        ];
        const r = await recipients();
        expect(r.noAccount).toEqual([137]);
        expect(r.list.map((x) => x.id)).toEqual([85]);
    });

    test('an employee governor with a linked admin account gets ONE recipient, on the ADMIN identity', async () => {
        // NotificationController.identity() is single-faced: a second brief on the
        // employee identity is a bell they can neither read nor silence while
        // signed in as an admin.
        state.governors = [
            { id: 85, firstName: 'A', username: 'a', accountActive: true, email: null },
        ];
        state.admins = [{ id: 9, username: 'ad', email: null, role: 'localadmin' }];
        state.linked = [{ adminId: 9, employeeId: 85 }];
        const r = await recipients();
        expect(r.list.filter((x) => x.type === 'employee')).toEqual([]);
        expect(r.list.find((x) => x.type === 'admin').teamOfEmployeeId).toBe(85);
    });
});

// ===========================================================================
describe('exactly once, and replayable without a duplicate', () => {
    test('three runs in a row produce ONE claim and ONE notification', async () => {
        jest.useFakeTimers().setSystemTime(new Date(Date.UTC(2026, 8, 7, 8)));
        state.admins = [{ id: 3, username: 'pm', email: null, role: 'localadmin' }];
        state.governors = [];
        const r1 = await job.tick();
        const r2 = await job.tick();
        const r3 = await job.tick();
        expect(r1.sent).toBe(1);
        expect(r2.sent).toBe(0);
        expect(r3.sent).toBe(0);
        expect(mockNotify.notify.mock.calls.length + mockNotify.enqueue.mock.calls.length).toBe(1);
        expect(state.claims.filter((c) => c.cadence === 'monthly').length).toBe(1);
    });

    test('the claim is an atomic INSERT … ON CONFLICT DO NOTHING RETURNING id, never a settings marker', () => {
        // manager-digest.js:39-44 reads a marker then writes it: two instances both
        // read "not sent yet" and both send.
        expect(JOB_SRC).toMatch(
            /INSERT INTO dept_briefs[\s\S]*ON CONFLICT \(cadence, period, recipient_type, recipient_id\) DO NOTHING[\s\S]*RETURNING id/
        );
        expect(JOB_SRC).not.toMatch(/setValue\('deptBriefLastSentOn/);
    });

    test('the brief is CALCULATED before it is claimed', async () => {
        jest.useFakeTimers().setSystemTime(new Date(Date.UTC(2026, 8, 7, 8)));
        state.admins = [{ id: 3, username: 'pm', email: null, role: 'localadmin' }];
        state.governors = [];
        const order = [];
        mockService.buildPayload.mockImplementation(async (r, c, win) => {
            order.push('build');
            return payload({ cadence: c, period: win.bucket });
        });
        const realGet = mockDb.get.getMockImplementation();
        mockDb.get.mockImplementation(async (sql, p) => {
            if (/INSERT INTO dept_briefs/i.test(sql)) order.push('claim');
            return realGet(sql, p);
        });
        await job.tick();
        expect(order[0]).toBe('build');
        expect(order).toContain('claim');
    });
});

// ===========================================================================
describe('cadence merge — four due, ONE message', () => {
    test('on 1 January all four buckets are claimed and exactly one brief is sent', async () => {
        jest.useFakeTimers().setSystemTime(new Date(Date.UTC(2027, 0, 1, 8)));
        state.admins = [{ id: 3, username: 'pm', email: null, role: 'localadmin' }];
        state.governors = [];
        const r = await job.tick();
        expect(state.claims.map((c) => c.cadence).sort()).toEqual([
            'monthly',
            'quarterly',
            'weekly',
            'yearly',
        ]);
        expect(mockNotify.notify.mock.calls.length + mockNotify.enqueue.mock.calls.length).toBe(1);
        expect(r.sent).toBe(1);
        // The LONGEST wins, and the message says which windows it absorbed.
        expect(r.cadence).toBe('yearly');
        const sent = mockNotify.notify.mock.calls[0][0];
        expect(sent.subject).toContain('Bilan annuel');
        expect(sent.html).toContain('Inclut');
        expect(sent.html).toMatch(/trimestre 2026-Q4/);
    });

    test('a recipient who is both a supervisor and a manager is ONE recipient, not two', async () => {
        // findGovernedIds returns the same population for both lines of
        // governance, so the DISTINCT recipient query cannot duplicate them.
        state.governors = [
            { id: 85, firstName: 'A', username: 'a', accountActive: true, email: null },
        ];
        const r = await recipients();
        expect(r.list.filter((x) => x.id === 85)).toHaveLength(1);
    });
});

// ===========================================================================
describe('release, retry and the anti-loop rule', () => {
    beforeEach(() => {
        state.admins = [{ id: 3, username: 'pm', email: null, role: 'localadmin' }];
        state.governors = [];
        jest.useFakeTimers().setSystemTime(new Date(Date.UTC(2026, 8, 7, 8)));
    });

    test('nothing landed → every claim is released, so the next tick retries', async () => {
        mockNotify.notify.mockImplementation(async () => ({ inapp: 'error', email: 'failed' }));
        const r = await job.tick();
        expect(state.deletes.length).toBeGreaterThan(0);
        expect(state.deletes.length).toBe(state.claims.length); // IN BULK, not just the emitted one
        expect(mockReminders.release).toHaveBeenCalledWith(
            'digest.any',
            'admin',
            3,
            0,
            expect.any(String)
        );
        expect(r.errors).toBe(1);
        expect(r.emailFailed).toBe(1);
    });

    test('the e-mail WENT OUT but the bell failed → the claim is KEPT and an alert is raised', async () => {
        // reminders.delivered() would call this a failure and re-send the same
        // brief every hour to every recipient.
        mockNotify.notify.mockImplementation(async () => ({ inapp: 'error', email: 'sent' }));
        const r = await job.tick();
        expect(state.deletes).toEqual([]);
        expect(mockJobRun.alert).toHaveBeenCalledWith(
            'ops.job_failed',
            expect.stringContaining('dept-brief:inapp:'),
            expect.any(Object)
        );
        expect(r.sent).toBe(1);
        expect(landed({ inapp: 'error', email: 'sent' })).toBe(true);
        expect(landed({ inapp: 'error', email: 'failed' })).toBe(false);
        expect(landed(null)).toBe(false);
    });

    test('the daily cap defers the send and releases the claims', async () => {
        mockReminders.claim.mockImplementation(async (kind) => kind !== 'digest.any');
        const r = await job.tick();
        expect(r.skipped.dailyCap).toBe(1);
        expect(r.sent).toBe(0);
        expect(state.deletes.length).toBe(state.claims.length);
        expect(mockNotify.notify).not.toHaveBeenCalled();
    });

    test('one recipient failing does not stop the run, and the partial failure is alerted once', async () => {
        state.admins = [
            { id: 3, username: 'a', email: null, role: 'localadmin' },
            { id: 4, username: 'b', email: null, role: 'localadmin' },
            { id: 5, username: 'c', email: null, role: 'localadmin' },
        ];
        mockService.buildPayload.mockImplementation(async (r, c, win) => {
            if (r.id === 4) throw new Error('boom');
            return payload({ cadence: c, period: win.bucket });
        });
        const r = await job.tick();
        expect(r.errors).toBe(1);
        expect(r.sent).toBe(2);
        expect(mockJobRun.alert).toHaveBeenCalledWith(
            'ops.job_failed',
            'dept-brief:partial:2026-08',
            expect.any(Object)
        );
    });
});

// ===========================================================================
describe('what is never sent', () => {
    beforeEach(() => {
        state.admins = [{ id: 3, username: 'pm', email: null, role: 'localadmin' }];
        state.governors = [];
        jest.useFakeTimers().setSystemTime(new Date(Date.UTC(2026, 8, 7, 8)));
    });

    test('an empty brief is ARCHIVED but not sent — and the archive row says so', async () => {
        mockService.buildPayload.mockImplementation(async (r, c, win) =>
            payload({ isEmpty: true, cadence: c, period: win.bucket })
        );
        const r = await job.tick();
        expect(r.empty).toBe(1);
        expect(r.sent).toBe(0);
        expect(mockNotify.notify).not.toHaveBeenCalled();
        expect(mockNotify.enqueue).not.toHaveBeenCalled();
        expect(state.claims.length).toBeGreaterThan(0); // the SERIES stays complete
        expect(state.deletes).toEqual([]); // and the claim is not handed back
        expect(JSON.parse(state.claims[0].payload).isEmpty).toBe(true);
    });

    test('the yearly cadence is the one exception, and it is a setting', async () => {
        jest.setSystemTime(new Date(Date.UTC(2027, 0, 1, 8)));
        mockService.buildPayload.mockImplementation(async (r, c, win) =>
            payload({ isEmpty: true, cadence: c, period: win.bucket })
        );
        const r = await job.tick();
        expect(r.sent).toBe(1);
        mockSettings.getValue.mockImplementation(async (k, d) =>
            k === 'deptBriefYearlySendEmpty' ? 'false' : k in SETTINGS ? SETTINGS[k] : d
        );
        jest.clearAllMocks();
        resetState({
            admins: [{ id: 3, username: 'pm', email: null, role: 'localadmin' }],
            governors: [],
        });
        wireDb();
        mockService.scopeOf.mockImplementation(async (x) => ({
            type: x.type,
            id: x.id,
            ids: [1, 2, 3, 4, 5],
            unrestricted: false,
            size: 5,
        }));
        mockService.buildPayload.mockImplementation(async (x, c, win) =>
            payload({ isEmpty: true, cadence: c, period: win.bucket })
        );
        mockReminders.claim.mockImplementation(async () => true);
        const r2 = await job.tick();
        expect(r2.sent).toBe(0);
        expect(r2.empty).toBe(1);
    });

    test('an admin with no live scope gets a ONE-LINE notice and NO archive row', async () => {
        // dept-digest.js:236 does `if (!rows.length) continue;` — a silence that
        // cannot be told apart from an outage. Measured: test.viewer #70.
        mockService.scopeOf.mockImplementation(async (x) => ({
            type: x.type,
            id: x.id,
            ids: [],
            unrestricted: false,
            size: 0,
        }));
        const r = await job.tick();
        expect(r.skipped.noScope).toBe(1);
        expect(state.claims).toEqual([]);
        expect(mockNotify.enqueue).toHaveBeenCalledTimes(1);
        expect(mockNotify.enqueue.mock.calls[0][0].payload.link).toBe('/admin/access-review');
        expect(mockReminders.claim).toHaveBeenCalledWith(
            'dept_brief.noscope',
            'admin',
            3,
            0,
            expect.any(String)
        );
    });
});

// ===========================================================================
describe('delivery', () => {
    beforeEach(() => {
        state.governors = [];
        jest.useFakeTimers().setSystemTime(new Date(Date.UTC(2026, 8, 7, 8)));
    });

    test('the notification payload carries NO figure — the webhook fan-out sees it first', async () => {
        // NotificationService._notify posts { userType, userId, category, payload }
        // to every enabled webhook BEFORE the in-app write, before the tier,
        // before the opt-out and before the category — with no scope check.
        state.admins = [{ id: 3, username: 'pm', email: null, role: 'localadmin' }];
        await job.tick();
        const sent = mockNotify.notify.mock.calls[0][0];
        expect(Object.keys(sent.payload).sort()).toEqual(['briefId', 'cadence', 'link', 'period']);
        expect(JSON.stringify(sent.payload)).not.toMatch(/headcount|coverage|readiness|\d+\/\d+/);
    });

    test('the weekly cadence is IN-APP ONLY — enqueue, never notify', async () => {
        state.admins = [{ id: 3, username: 'pm', email: null, role: 'localadmin' }];
        state.prefs = [
            { cadence: 'monthly', enabled: false },
            { cadence: 'quarterly', enabled: false },
            { cadence: 'yearly', enabled: false },
        ];
        const r = await job.tick();
        expect(r.cadence).toBe('weekly');
        expect(mockNotify.enqueue).toHaveBeenCalledTimes(1);
        expect(mockNotify.notify).not.toHaveBeenCalled();
        expect(mockNotify.enqueue.mock.calls[0][0].channel).toBe('inapp');
    });

    test('a SHARED mailbox falls back to in-app only and is reported', async () => {
        // Since migration 107 one address may belong to several accounts. The
        // flows that assumed otherwise must REFUSE the ambiguity, not guess.
        state.admins = [{ id: 3, username: 'pm', email: 'shared@dept', role: 'localadmin' }];
        mockAccounts.accountsWithEmail.mockImplementation(async () => [
            { kind: 'admin', id: 3, isActive: true },
            { kind: 'employee', id: 90, isActive: true },
        ]);
        const r = await job.tick();
        expect(r.skipped.sharedMailbox).toEqual(['admin:3']);
        expect(mockNotify.notify).not.toHaveBeenCalled();
        expect(mockNotify.enqueue).toHaveBeenCalledTimes(1);
    });

    test('the previous unread briefs are superseded before the new one is written', async () => {
        // telemetry-prune only deletes READ notifications, and 259 of 262 rows on
        // the development database are unread: without this the bell fills with
        // briefs and stops signalling anything, including a dispute escalation.
        state.admins = [{ id: 3, username: 'pm', email: null, role: 'localadmin' }];
        state.superseded = 2;
        const r = await job.tick();
        expect(r.superseded).toBe(2);
        const sql = state.updates
            .map((u) => u.sql)
            .find((s) => /UPDATE notifications SET read_at/.test(s || ''));
        expect(sql).toMatch(/kind = 'dept_brief'/);
        expect(sql).toMatch(/read_at IS NULL/);
    });

    test('the e-mail category is evaluated BEFORE any claim, and never suppresses the in-app line', async () => {
        // personal-digest.js:28-39: "Claiming first burned the day". But the
        // in-app line is the deliverable — SMTP being off must not make the brief
        // invisible (this box: enableEmailNotifications = false).
        state.admins = [{ id: 3, username: 'pm', email: null, role: 'localadmin' }];
        mockEmail.isCategoryEnabled.mockImplementation(async () => false);
        const order = [];
        mockEmail.isCategoryEnabled.mockImplementation(async () => {
            order.push('category');
            return false;
        });
        const realGet = mockDb.get.getMockImplementation();
        mockDb.get.mockImplementation(async (sql, p) => {
            if (/INSERT INTO dept_briefs/i.test(sql)) order.push('claim');
            return realGet(sql, p);
        });
        const r = await job.tick();
        expect(order[0]).toBe('category');
        expect(r.emailCategory).toBe(false);
        expect(r.sent).toBe(1);
    });
});

// ===========================================================================
describe('the result is compact, honest and readable on /admin/health', () => {
    test('it stays well under the 4 KB the ledger truncates at, and names every skip', async () => {
        jest.useFakeTimers().setSystemTime(new Date(Date.UTC(2026, 8, 7, 8)));
        state.admins = [{ id: 3, username: 'pm', email: null, role: 'localadmin' }];
        state.governors = [
            { id: 137, firstName: 'M', username: null, accountActive: false, email: null },
        ];
        const r = await job.tick();
        expect(JSON.stringify(r).length).toBeLessThan(4096);
        expect(Object.keys(r.skipped).sort()).toEqual(
            [
                'notDue',
                'dailyCap',
                'noAccount',
                'noScope',
                'optedOut',
                'prefOff',
                'sharedMailbox',
                'tooLate',
            ].sort()
        );
        expect(r).toMatchObject({
            cadence: 'monthly',
            period: '2026-08',
            recipients: 1,
            sent: 1,
            coverage: '5/76',
        });
        expect(r.leader).toBe('inproc');
        // A first period has no predecessor: that is "not measured", never 0 %.
        expect(r.readRatePct).toBeNull();
    });

    test('a long noAccount list is capped rather than truncated mid-JSON', async () => {
        jest.useFakeTimers().setSystemTime(new Date(Date.UTC(2026, 8, 7, 8)));
        state.admins = [{ id: 3, username: 'pm', email: null, role: 'localadmin' }];
        state.governors = Array.from({ length: 40 }, (_, i) => ({
            id: 200 + i,
            username: null,
            accountActive: false,
            email: null,
            firstName: 'x',
        }));
        const r = await job.tick();
        expect(r.skipped.noAccount).toHaveLength(21);
        expect(r.skipped.noAccount[20]).toBe('+20');
    });

    test('HealthController turns a skipped run into a NEUTRAL flash, not a green one', () => {
        const HealthController = require('../../src/controllers/HealthController');
        expect(HealthController._skipReason({ skipped: 'not_due' })).toBe('not_due');
        expect(
            HealthController._skipReason({
                sent: 0,
                recipients: 3,
                skipped: { notDue: 3, noAccount: [] },
            })
        ).toBe('notDue=3');
        expect(HealthController._skipReason({ sent: 2, skipped: { notDue: 1 } })).toBeNull();
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/controllers/HealthController.js'),
            'utf8'
        );
        // 'info' is written to the session and NEVER rendered (flash.ejs handles
        // success / warnings / errors only).
        expect(src).toMatch(
            /req\.flash\(\s*'warning',\s*req\.t\s*\?\s*req\.t\('admin:health_run_skipped'/
        );
        expect(src).not.toMatch(/req\.flash\('info'/);
    });

    test('the SMTP failure counter reads the action EmailService actually logs', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/controllers/HealthController.js'),
            'utf8'
        );
        expect(src).toMatch(/'EMAIL_TEST_FAILED','EMAIL_SEND_FAILED','EMAIL_FAILED'/);
        const email = fs.readFileSync(
            path.join(__dirname, '../../src/services/EmailService.js'),
            'utf8'
        );
        expect(email).toMatch(/EMAIL_FAILED/);
    });

    test('"Renvoyer un bilan" is built on the backupNow model: ledger + audit log + flash', () => {
        const HealthController = require('../../src/controllers/HealthController');
        expect(typeof HealthController.resendBrief).toBe('function');
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/controllers/HealthController.js'),
            'utf8'
        );
        const fn = src.slice(
            src.indexOf('async resendBrief'),
            src.indexOf('/** History of one tick')
        );
        expect(fn).toMatch(/JobRunService\.run\(tick, \{ trigger: 'manual', actorRef \}\)/);
        expect(fn).toMatch(/LogService\.log/);
        expect(fn).toMatch(/resend: \{ cadence, period, only: \{ userType, userId \} \}/);
    });
});

// ===========================================================================
describe('manual replay', () => {
    test('resend re-renders the ARCHIVED payload and never recomputes', async () => {
        const archived = payload();
        state.archived = { id: 77, payload: JSON.stringify(archived), isEmpty: false };
        const r = await job.tick({
            resend: {
                cadence: 'monthly',
                period: '2026-08',
                only: { userType: 'admin', userId: 3 },
            },
        });
        expect(r.sent).toBe(1);
        expect(r.resent).toBe(true);
        expect(mockService.buildPayload).not.toHaveBeenCalled(); // no recomputation
        expect(state.claims).toEqual([]); // no new claim
    });

    test('two resends of the same archive produce byte-identical HTML', async () => {
        state.archived = { id: 77, payload: JSON.stringify(payload()), isEmpty: false };
        await job.tick({
            resend: {
                cadence: 'monthly',
                period: '2026-08',
                only: { userType: 'admin', userId: 3 },
            },
        });
        await job.tick({
            resend: {
                cadence: 'monthly',
                period: '2026-08',
                only: { userType: 'admin', userId: 3 },
            },
        });
        const [a, b] = mockNotify.notify.mock.calls.map((c) => c[0].html);
        expect(a).toBe(b);
    });

    test('a resend without a recipient is refused, and says why', async () => {
        const r = await job.tick({ resend: { cadence: 'monthly', period: '2026-08' } });
        expect(r.sent).toBe(0);
        expect(r.reason).toBe('resend_needs_cadence_period_and_recipient');
    });

    test('a forced run writes a NEW VERSION and the e-mail says it was recomputed', async () => {
        jest.useFakeTimers().setSystemTime(new Date(Date.UTC(2026, 8, 13, 8)));
        state.admins = [{ id: 3, username: 'pm', email: null, role: 'localadmin' }];
        state.governors = [];
        state.conflicts.add('quarterly|2026-Q2|admin|3'); // already sent once
        const r = await job.tick({ force: true, cadence: 'quarterly', period: '2026-Q2' });
        expect(state.updates.some((u) => u.forced)).toBe(true);
        expect(r.sent).toBe(1);
        expect(mockNotify.notify.mock.calls[0][0].html).toMatch(/Recalculé le/);
    });

    test('a forced run NEVER deletes the archived brief it re-versioned', async () => {
        // Measured the hard way on idevelop: with the daily cap already taken by
        // the morning run, the force path released "its" claim — and the release
        // deleted a row it had only UPDATED, i.e. a brief a human had received.
        // Only rows this run INSERTED may be released, and a force bypasses the
        // cap because it is an explicit, audited human action.
        jest.useFakeTimers().setSystemTime(new Date(Date.UTC(2026, 8, 13, 8)));
        state.admins = [{ id: 3, username: 'pm', email: null, role: 'localadmin' }];
        state.governors = [];
        state.conflicts.add('quarterly|2026-Q2|admin|3');
        mockReminders.claim.mockImplementation(async (kind) => kind !== 'digest.any'); // cap already taken today
        const r = await job.tick({ force: true, cadence: 'quarterly', period: '2026-Q2' });
        expect(state.deletes).toEqual([]);
        expect(r.skipped.dailyCap).toBe(0);
        expect(r.sent).toBe(1);
    });

    test('without `force`, a period that is not due is refused', async () => {
        jest.useFakeTimers().setSystemTime(new Date(Date.UTC(2026, 8, 13, 8)));
        state.admins = [{ id: 3, username: 'pm', email: null, role: 'localadmin' }];
        state.governors = [];
        const r = await job.tick({ cadence: 'quarterly', period: '2026-Q2' });
        expect(r.sent).toBe(0);
        expect(mockNotify.notify).not.toHaveBeenCalled();
    });
});

// ===========================================================================
describe('the e-mail body', () => {
    const render = (p = payload(), opts = {}) =>
        renderBlocks(p, {
            appName: 'ACME',
            accent: '#123456',
            baseUrl: 'http://x',
            maxLines: 7,
            ...opts,
        });

    test('it is BARE BLOCKS — no second document inside the shell', () => {
        const { html } = render();
        expect(html).not.toMatch(/<!doctype/i);
        expect(html).not.toMatch(/<html/i);
        expect(html).not.toMatch(/<body/i);
        // The three existing digests hand _render a COMPLETE wrap() document,
        // which _shell then wraps again: two brand headers, two footers.
        const T = require('../../src/utils/emailTemplate');
        expect(T.wrap({ branding: {}, title: 't', intro: 'i', blocks: [] })).toMatch(/<body/i);
    });

    test('after _render there is exactly ONE shell footer', () => {
        jest.unmock('../../src/services/NotificationService');
        const Real = jest.requireActual('../../src/services/NotificationService');
        const { subject, html, text } = render();
        const out = Real._render({
            kind: 'dept_brief',
            payload: {},
            subject,
            html,
            text,
            brand: { appName: 'ACME' },
            recipientName: 'X',
            locale: 'fr',
        });
        expect((out.html.match(/Ceci est un message automatique/g) || []).length).toBe(1);
        expect((out.html.match(/<!doctype/gi) || []).length).toBeLessThanOrEqual(1);
    });

    test('the subject is branded from settings, never a hard-coded [IDevelop]', () => {
        expect(render().subject).toBe('ACME — Bilan mensuel — 2026-08');
        expect(JOB_SRC).not.toMatch(/\[IDevelop\]/);
    });

    test('the header carries the period with INCLUSIVE bounds, in UTC', () => {
        const { html } = render();
        expect(html).toContain('01/08/2026');
        expect(html).toContain('31/08/2026'); // periodEnd − 1 day, "inclus"
        expect(html).toContain('inclus');
        expect(html).not.toMatch(/2026-08-01T/); // never an ISO timestamp
        expect(html).not.toMatch(/GMT\+/); // never a Date.toString()
    });

    test('an unmeasured figure is an em dash, never a 0 and never amber', () => {
        const { html } = render();
        const foot = html.slice(html.indexOf('État mesuré'));
        expect(foot).toContain('—');
        expect(foot).not.toMatch(/0[.,]0\s?%/);
        // The unmeasured footer cells carry no colour at all.
        expect(foot).not.toMatch(/color:#b45309[^>]*>\s*—/);
    });

    test('a section whose every line is unmeasured gets a GREY heading, not amber', () => {
        const p = payload();
        p.blocks.C = [
            {
                id: 'C1',
                severity: 'action',
                title: { fr: 'Certifications', en: 'Certifications' },
                lines: [
                    {
                        unitId: 11,
                        label: { fr: 'u', en: 'u' },
                        expiring: {
                            value: null,
                            text: { fr: '—', en: '—' },
                            state: 'unmeasured',
                            color: '#64748b',
                        },
                    },
                ],
            },
        ];
        const { html } = render(p);
        const head = html.slice(
            html.indexOf('Certifications') - 120,
            html.indexOf('Certifications')
        );
        expect(head).toContain('#64748b');
        expect(head).not.toContain('#b45309');
    });

    test('the action lines are capped, and the overflow is stated rather than dropped silently', () => {
        const p = payload();
        p.blocks.A[0].lines = Array.from({ length: 12 }, (_, i) => ({
            unitId: 11,
            label: { fr: `u${i}`, en: `u${i}` },
            count: {
                value: i + 1,
                text: { fr: String(i + 1), en: String(i + 1) },
                state: 'measured',
                color: null,
            },
        }));
        const { html, text } = render(p, { maxLines: 3 });
        expect(html).toContain('+9 autres actions');
        expect(text).toContain('+9 autres actions');
    });

    test('past-SLA lines are ranked first, oldest first', () => {
        const p = payload();
        const line = (id, overdue, age) => ({
            unitId: 11,
            label: { fr: id, en: id },
            overdue,
            oldestAge: {
                value: age,
                text: { fr: `${age} jours`, en: `${age} days` },
                state: 'measured',
                color: null,
            },
            count: { value: 1, text: { fr: '1', en: '1' }, state: 'measured', color: null },
        });
        p.blocks.A[0].lines = [
            line('fresh', false, 1),
            line('old', true, 30),
            line('less-old', true, 9),
            line('middling', true, 4),
        ];
        // 3 is the floor deptBriefMaxLines accepts (3-12), so three of four survive.
        const { text } = render(p, { maxLines: 3 });
        const kept = text.split('\n').filter((l) => l.startsWith('- '));
        expect(kept[0]).toContain('old');
        expect(kept[1]).toContain('less-old');
        expect(text).not.toContain('fresh');
    });

    test('a partial period is stated and carries NO change figure', () => {
        const p = payload();
        p.partialPeriod = { since: new Date(Date.UTC(2026, 7, 15)) };
        p.flow.lines[0].delta = {
            state: 'suppressed',
            reason: 'partial_period',
            value: null,
            pct: null,
        };
        const { html } = render(p);
        expect(html).toContain('Période partielle');
        expect(html).toContain('15/08/2026');
        expect(html).toContain('évolution supprimée');
        expect(html).not.toMatch(/\+2\s*\(\+100/);
    });

    test('a Δ that cannot be computed is a WORD, never an arrow and never a 0', () => {
        for (const [st, word] of [
            ['first_measure', 'première mesure'],
            ['measure_lost', 'mesure perdue'],
            ['scope_changed', 'périmètre modifié'],
        ]) {
            const p = payload();
            p.flow.lines[0].delta = { state: st, value: null, pct: null };
            expect(render(p).html).toContain(word);
        }
    });

    test('the series-start footnote is published', () => {
        expect(render().html).toContain('La série de vos bilans mensuels a commencé le 01/07/2026');
    });

    test('the frozen-figures line and the fixed disclaimer are always present', () => {
        const { html } = render();
        expect(html).toContain('Chiffres figés au 01/09/2026');
        expect(html).toContain('Les chiffres non mesurés sont affichés');
        expect(html).toContain('Gérer la fréquence de ce bilan');
    });

    test('a linked admin/employee brief carries TWO labelled scopes in ONE message', () => {
        // §3.4. Without the labels the reader cannot tell which population a
        // figure describes — and two briefs are not an option: the notification
        // identity is single-faced, so the employee bell would be unreadable and
        // unstoppable while they are signed in as an admin.
        const p = payload();
        p.team = payload();
        p.team.units = [
            {
                unitId: 12,
                unitName: 'Exploration / IT',
                headcount: 3,
                totalHeadcount: 3,
                withoutRequirements: 0,
                label: {
                    fr: 'Votre équipe dans Exploration / IT — 3 personnes',
                    en: 'Your team in Exploration / IT — 3 people',
                },
            },
        ];
        p.team.footer.units[0].label = { fr: 'Exploration / IT', en: 'Exploration / IT' };
        const { html } = render(p);
        expect(html).toContain('Votre périmètre d’administration');
        expect(html).toContain('Votre équipe');
        expect(html).toContain('Votre équipe dans Exploration / IT — 3 personnes');
        expect(html).toContain('Riverside / IT — votre périmètre : 5 personnes sur 36');
        expect((html.match(/État mesuré/g) || []).length).toBe(2); // one per scope
    });

    test('rendering is PURE — same payload, same bytes, no clock of its own', () => {
        const p = payload();
        expect(render(p).html).toBe(render(p).html);
        const body = JOB_SRC.slice(
            JOB_SRC.indexOf('function renderBlocks'),
            JOB_SRC.indexOf('/** An arrow only when')
        );
        expect(body).not.toMatch(/new Date\(\)/);
        expect(body).not.toMatch(/\bdb\./);
    });
});

// ===========================================================================
describe('notification wiring', () => {
    const Real = jest.requireActual('../../src/services/NotificationService');

    test('dept_brief has META and a real bilingual message', () => {
        const meta = Real.KIND_META.dept_brief;
        expect(meta).toBeTruthy();
        expect(meta.icon).toBeTruthy();
        expect(meta.link.startsWith('/')).toBe(true);
        expect(meta.title.fr).toBeTruthy();
        expect(meta.title.en).toBeTruthy();
        expect(meta.title.fr).not.toBe(meta.title.en);
        const msg = Real.KIND_MESSAGES.dept_brief;
        expect(msg.fr).toBeTruthy();
        expect(msg.en).toBeTruthy();
    });

    test('it has NO KIND_POLICY tier, and the reason is written down', () => {
        // A 'digest' tier would hit `if (tier === 'digest') { result.email =
        // 'digest_deferred'; return result; }` and the composed brief would never
        // be sent. The jest invariant only checks POLICY → META, so this omission
        // is invisible to the suite: the comment is the guard.
        expect(Real.KIND_POLICY.dept_brief).toBeUndefined();
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/services/NotificationService.js'),
            'utf8'
        );
        expect(src).toMatch(/'dept_brief' is DELIBERATELY ABSENT/);
    });

    test('one kind, no dot — so the centre gives it one family, and that family is translated', () => {
        expect('dept_brief'.includes('.')).toBe(false);
        for (const lang of ['fr', 'en']) {
            const chrome = require(`../../locales/${lang}/chrome.json`);
            expect(chrome.notif_family_dept_brief).toBeTruthy();
        }
    });

    test('the daily digest lists the last 24 h only', () => {
        // personal-digest.js:48-55 selects recipients on a 24 h window; sendDigest
        // did not reuse it, so an unread notification was re-listed at the top of
        // every day's summary for ever.
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/services/NotificationService.js'),
            'utf8'
        );
        const call = /const rows = await NotificationService\.listInApp\(([^)]*)\)/.exec(src)[1];
        expect(call).toMatch(/sinceHours: 24/);
        expect(src).toMatch(/interval '\$\{hours\} hours'/);
    });

    test('the inbox itself is NOT bounded — only the digest is', async () => {
        const sqls = [];
        mockDb.all.mockImplementation(async (sql) => {
            sqls.push(sql);
            return [];
        });
        await Real.listInApp({ userType: 'admin', userId: 1, limit: 8 });
        expect(sqls[0]).not.toMatch(/interval/);
        await Real.listInApp({ userType: 'admin', userId: 1, limit: 8, sinceHours: 24 });
        expect(sqls[1]).toMatch(/created_at >= now\(\) - interval '24 hours'/);
    });
});

// ===========================================================================
describe('the settings catalogue', () => {
    const Real = jest.requireActual('../../src/models/AppSettingsModel');
    const SRC = fs.readFileSync(
        path.join(__dirname, '../../src/models/AppSettingsModel.js'),
        'utf8'
    );
    const KEYS = [
        'deptBriefWeeklyEnabled',
        'deptBriefMonthlyEnabled',
        'deptBriefQuarterlyEnabled',
        'deptBriefYearlyEnabled',
        'deptBriefYearlySendEmpty',
        'deptBriefHour',
        'deptBriefWeeklyDow',
        'deptBriefMonthlyDom',
        'deptBriefQuarterlyDom',
        'deptBriefYearlyDom',
        'deptBriefReviewSlaDays',
        'deptBriefMaxLines',
        'deptBriefReadRateFloorPct',
        'deptBriefLastRunOn',
        'deptBriefSince',
        'deptBriefDataSince',
    ];

    test('every key is seeded, and in the category the settings page actually renders', () => {
        // views/pages/app-settings/index.ejs:25-31 holds a hard-coded whitelist:
        // a setting filed anywhere else is loaded, validated… and never shown.
        for (const k of KEYS) {
            const i = SRC.indexOf(`key: '${k}'`);
            expect(i).toBeGreaterThan(-1);
            expect(SRC.slice(i, i + 600)).toMatch(/category: 'jobs'/);
        }
    });

    test('each one validates, and refuses what it must', () => {
        expect(Real.validate('deptBriefMaxLines', 'number', '7')).toEqual({ ok: true, value: '7' });
        expect(Real.validate('deptBriefMaxLines', 'number', '2').ok).toBe(false);
        expect(Real.validate('deptBriefMaxLines', 'number', '13').ok).toBe(false);
        expect(Real.validate('deptBriefReadRateFloorPct', 'number', '101').ok).toBe(false);
        expect(Real.validate('deptBriefHour', 'number', '24').ok).toBe(false); // …Hour ⇒ 0-23
        expect(Real.validate('deptBriefHour', 'number', '23').ok).toBe(true);
        expect(Real.validate('deptBriefWeeklyDow', 'number', '7').ok).toBe(false); // …Dow ⇒ 0-6
        expect(Real.validate('deptBriefMonthlyDom', 'number', '29').ok).toBe(false); // …Dom ⇒ 1-28
        expect(Real.validate('deptBriefReviewSlaDays', 'number', '-1').ok).toBe(false);
        expect(Real.validate('deptBriefWeeklyEnabled', 'boolean', 'true')).toEqual({
            ok: true,
            value: 'true',
        });
        expect(Real.validate('deptBriefWeeklyEnabled', 'boolean', 'yes')).toEqual({
            ok: true,
            value: 'false',
        });
        // Job-written markers are refused by the form, not silently accepted.
        expect(Real.validate('deptBriefLastRunOn', 'string', 'x')).toMatchObject({
            ok: false,
            code: 'readonly',
        });
        expect(Real.validate('deptBriefSince', 'string', 'x')).toMatchObject({
            ok: false,
            code: 'readonly',
        });
        expect(Real.validate('deptBriefDataSince', 'string', 'x')).toMatchObject({
            ok: false,
            code: 'readonly',
        });
    });

    test('every key has a NAME and a DESCRIPTION in BOTH languages', () => {
        // A missing set_name_ renders the RAW KEY; a missing set_desc_ falls back
        // to the English description stored in the database.
        const fr = require('../../locales/fr/admin.json');
        const en = require('../../locales/en/admin.json');
        const missing = [];
        for (const k of KEYS) {
            for (const p of ['set_name_', 'set_desc_']) {
                if (!fr[p + k]) missing.push(`fr:${p}${k}`);
                if (!en[p + k]) missing.push(`en:${p}${k}`);
            }
        }
        expect(missing).toEqual([]);
        expect(fr.health_run_skipped).toBeTruthy();
        expect(en.health_run_skipped).toBeTruthy();
        expect(fr.health_run_skipped).not.toBe(en.health_run_skipped);
    });

    test('a settings failure never kills a tick', async () => {
        jest.useFakeTimers().setSystemTime(new Date(Date.UTC(2026, 8, 7, 8)));
        state.admins = [{ id: 3, username: 'pm', email: null, role: 'localadmin' }];
        state.governors = [];
        mockSettings.getValue.mockImplementation(async () => {
            throw new Error('settings down');
        });
        const r = await job.tick();
        expect(r.errors).toBe(0);
        expect(r.sent).toBe(1); // fell back to the defaults and carried on
    });
});
