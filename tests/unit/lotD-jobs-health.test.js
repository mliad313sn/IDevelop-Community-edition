'use strict';

// Lot D — D1: the job ledger, the backup card and the health page.
// Findings: L4-01 (no run ledger), L4-02 (backup status lies / 0-byte dump),
// L4-17 (pending migrations, DB size), L4-18 (SMTP verified state), L4-23 (no ops alerting).
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// --- DB double: every JobRunService query goes through here ------------------
const mockRows = { job_runs: [], notifications: [], admins: [{ id: 1 }, { id: 7 }] };
const mockCalls = [];
const mockDb = {
    run: jest.fn(async (sql, params) => {
        mockCalls.push({ sql, params });
        return { lastID: 42, changes: 1 };
    }),
    get: jest.fn(async (sql, params) => {
        mockCalls.push({ sql, params });
        return mockRows._get;
    }),
    all: jest.fn(async (sql, params) => {
        mockCalls.push({ sql, params });
        return mockRows._all || [];
    }),
};
jest.mock('../../src/config/database', () => mockDb);

const mockNotify = { notify: jest.fn(async () => ({ ok: true })) };
jest.mock('../../src/services/NotificationService', () => mockNotify);

const JobRunService = require('../../src/services/JobRunService');

beforeEach(() => {
    mockCalls.length = 0;
    mockRows._get = null;
    mockRows._all = [];
    mockDb.run.mockClear();
    mockDb.get.mockClear();
    mockDb.all.mockClear();
    mockNotify.notify.mockClear();
    JobRunService._watchdogAt = 0;
});

describe('L4-01 — every tick execution lands in the job_runs ledger', () => {
    test('a successful run opens and closes a row, and returns the tick result', async () => {
        const tick = {
            name: 'kpi-snapshot.tick',
            everyMin: 60,
            fn: jest.fn(async () => ({ snapshots: 3 })),
        };
        const out = await JobRunService.run(tick, { trigger: 'manual', actorRef: 'admin:1' });
        expect(out).toEqual({ snapshots: 3 });
        const insert = mockCalls.find((c) => /INSERT INTO job_runs/.test(c.sql));
        expect(insert.params).toEqual(['kpi-snapshot.tick', 'manual', 'admin:1']);
        const update = mockCalls.find((c) => /UPDATE job_runs/.test(c.sql));
        expect(update.params[0]).toBe(true); // ok
        expect(update.params[1]).toBeNull(); // error
        expect(JSON.parse(update.params[2])).toEqual({ snapshots: 3 });
    });

    test('a failing run records the error, alerts the SuperAdmins and re-throws', async () => {
        const tick = {
            name: 'cycle-deadline.tick',
            everyMin: 60,
            fn: jest.fn(async () => {
                throw new Error('boom');
            }),
        };
        mockRows._get = null; // no alert sent today yet
        mockRows._all = [{ id: 1 }, { id: 7 }]; // two active superadmins
        await expect(JobRunService.run(tick, {})).rejects.toThrow('boom');
        const update = mockCalls.find((c) => /UPDATE job_runs/.test(c.sql));
        expect(update.params[0]).toBe(false);
        expect(update.params[1]).toBe('boom');
        expect(mockNotify.notify).toHaveBeenCalledTimes(2);
        const first = mockNotify.notify.mock.calls[0][0];
        expect(first).toMatchObject({
            userType: 'admin',
            kind: 'ops.job_failed',
            category: 'digest',
        });
        expect(first.payload).toMatchObject({
            tick: 'cycle-deadline.tick',
            dedupKey: 'cycle-deadline.tick',
            link: '/admin/health',
        });
    });

    test('a ledger hiccup never stops a tick (start/finish swallow their own errors)', async () => {
        mockDb.run.mockRejectedValueOnce(new Error('ledger down'));
        await expect(JobRunService.start('x.tick', {})).resolves.toBeNull();
        mockDb.run.mockRejectedValueOnce(new Error('ledger down'));
        await expect(JobRunService.finish(1, { ok: true })).resolves.toBeUndefined();
    });

    test('an oversized result is truncated instead of bloating the row', async () => {
        await JobRunService.finish(1, { ok: true, result: { blob: 'x'.repeat(9000) } });
        const update = mockCalls.find((c) => /UPDATE job_runs/.test(c.sql));
        const stored = JSON.parse(update.params[2]);
        expect(stored.truncated).toBe(true);
        expect(update.params[2].length).toBeLessThan(4096);
    });
});

describe('J6/J10 — a tick that RETURNS failures (without throwing) is still surfaced', () => {
    test('all units failed, none succeeded → run closes ok=false and alerts', async () => {
        mockRows._all = [{ id: 1 }]; // one superadmin to receive the alert
        const tick = {
            name: 'retention-recompute.tick',
            everyMin: 60,
            fn: jest.fn(async () => ({ computed: 0, failed: 76 })),
        };
        const out = await JobRunService.run(tick, {});
        expect(out).toEqual({ computed: 0, failed: 76 }); // caller still receives the result — no throw
        const update = mockCalls.find((c) => /UPDATE job_runs/.test(c.sql));
        expect(update.params[0]).toBe(false); // ok = false: nothing succeeded
        const alert = mockNotify.notify.mock.calls.find((c) => c[0].kind === 'ops.job_failed');
        expect(alert).toBeTruthy();
        expect(alert[0].payload).toMatchObject({
            tick: 'retention-recompute.tick',
            partial: false,
        });
    });

    test('a partial pass (some units worked) alerts but stays ok=true', async () => {
        mockRows._all = [{ id: 1 }];
        const tick = {
            name: 'kpi-snapshot.tick',
            everyMin: 60,
            fn: jest.fn(async () => ({ captured: 8, failed: [{ site: 'X' }] })),
        };
        await JobRunService.run(tick, {});
        const update = mockCalls.find((c) => /UPDATE job_runs/.test(c.sql));
        expect(update.params[0]).toBe(true); // honest: it did produce work
        const alert = mockNotify.notify.mock.calls.find((c) => c[0].kind === 'ops.job_failed');
        expect(alert[0].payload).toMatchObject({ partial: true });
    });

    test('a clean result (failed:0) neither alerts nor fails', async () => {
        const tick = {
            name: 'dept-digest.tick',
            everyMin: 60,
            fn: jest.fn(async () => ({ sent: 3, due: 3, failed: 0 })),
        };
        await JobRunService.run(tick, {});
        const update = mockCalls.find((c) => /UPDATE job_runs/.test(c.sql));
        expect(update.params[0]).toBe(true);
        expect(mockNotify.notify).not.toHaveBeenCalled();
    });

    test('the retention sweep is watched as a DAILY tick', () => {
        expect(JobRunService.DAILY_TICKS).toContain('retention-recompute.tick');
    });
});

describe('L4-23 — ops alerts are de-duplicated per day', () => {
    test('an alert already sent today notifies nobody', async () => {
        mockRows._get = { x: 1 }; // today's row exists
        const n = await JobRunService.alert('ops.backup_stale', 'backup:2026-09-01', {});
        expect(n).toBe(0);
        expect(mockNotify.notify).not.toHaveBeenCalled();
    });

    test('the de-dup predicate is (kind, inapp, today, payload.dedupKey)', async () => {
        mockRows._get = { x: 1 };
        await JobRunService.alert('ops.smtp_failed', 'schedule:6', {});
        const q = mockCalls.find((c) => /FROM notifications/.test(c.sql));
        expect(q.sql).toMatch(/kind = \?/);
        expect(q.sql).toMatch(/channel = 'inapp'/);
        expect(q.sql).toMatch(/created_at::date = now\(\)::date/);
        expect(q.sql).toMatch(/payload->>'dedupKey' = \?/);
        expect(q.params).toEqual(['ops.smtp_failed', 'schedule:6']);
    });

    test('the watchdog self-gates to once an hour', async () => {
        JobRunService._watchdogAt = Date.now();
        await expect(JobRunService.watchdog()).resolves.toBeNull();
    });
});

describe('nextDue — a stale tick reads as overdue, an unrun tick as unmeasured', () => {
    const tick = { name: 't', everyMin: 60 };
    test('never run → null (never a fabricated date)', () => {
        expect(JobRunService.nextDue(tick, null)).toBeNull();
        expect(JobRunService.nextDue(tick, 'not-a-date')).toBeNull();
    });
    test('last run + period; more than one period late is overdue', () => {
        const now = Date.parse('2026-09-11T10:00:00Z');
        expect(JobRunService.nextDue(tick, '2026-09-11T09:30:00Z', now)).toMatchObject({
            overdue: false,
        });
        expect(JobRunService.nextDue(tick, '2026-09-11T06:00:00Z', now).overdue).toBe(true);
    });
});

describe('L4-02 — the backup card tells the truth', () => {
    const src = read('src/jobs/db-backup.js');

    test('a 0-byte dump is a FAILURE and the file is removed', () => {
        expect(src).toMatch(/if \(!size\) status = 'failed: empty dump file'/);
        expect(src).toMatch(/fs\.unlinkSync\(file\)/);
    });

    test('the path and the size are recorded next to the status', () => {
        expect(src).toMatch(/setValue\(\s*'backupLastFile'/);
        expect(src).toMatch(/setValue\(\s*'backupLastSize'/);
    });

    test('the directory resolves BACKUP_DIR → %ProgramData%\\IDevelop\\backups → cwd', () => {
        expect(src).toMatch(/process\.env\.BACKUP_DIR/);
        expect(src).toMatch(/path\.join\(pd, 'IDevelop', 'backups'\)/);
        expect(src).toMatch(/fs\.accessSync\(candidate, fs\.constants\.W_OK\)/);
        expect(src).toMatch(/path\.join\(process\.cwd\(\), 'backups', 'auto'\)/);
    });

    test('"never backed up" is unmeasured (stale = null), not an alert', () => {
        expect(src).toMatch(/const stale = files\.length === 0 \? null :/);
    });

    test('a fractional backupKeep can never slice the whole set away', () => {
        expect(src).toMatch(
            /Number\.isFinite\(k\) && k >= 1\)?\s*\?\s*Math\.floor\(k\)\s*:\s*Infinity/
        );
    });

    test('status() is exported for the health page and the watchdog', () => {
        expect(require('../../src/jobs/db-backup')).toEqual(
            expect.objectContaining({
                tick: expect.any(Function),
                status: expect.any(Function),
                listBackups: expect.any(Function),
                backupDir: expect.any(Function),
            })
        );
    });
});

describe('the TICKS registry and the health page are one and the same list', () => {
    const jobsSrc = read('src/jobs/index.js');
    const view = read('views/pages/admin/health.ejs');

    test('both runtimes and the button go through the ledger', () => {
        expect(jobsSrc).toMatch(
            /function runTick\(tick, \{ trigger = 'schedule', actorRef = null \} = \{\}\) \{\s*return require\('\.\.\/services\/JobRunService'\)\.run/
        );
        expect(jobsSrc).toMatch(
            /return tick \? runTick\(tick, \{ trigger: 'schedule' \}\) : null;/
        ); // BullMQ worker
        expect(jobsSrc).toMatch(/async function runTickByName/);
        expect(jobsSrc).toMatch(/module\.exports = \{[^}]*runTickByName[^}]*TICKS/s);
    });

    test('every registry entry is renderable and the page iterates the registry', () => {
        const { TICKS } = require('../../src/jobs');
        expect(TICKS.length).toBeGreaterThanOrEqual(20);
        TICKS.forEach((t) => {
            expect(typeof t.name).toBe('string');
            expect(t.everyMin).toBeGreaterThan(0);
            expect(typeof t.fn).toBe('function');
        });
        expect(view).toMatch(/ticks\.forEach/);
        expect(view).toMatch(/\/admin\/health\/run\/<%= encodeURIComponent\(t\.name\) %>/);
    });

    test('the watchdog rides on the scheduler, without a 21st tick', () => {
        expect(jobsSrc).toMatch(/JobRunService'\)\s*\.watchdog\(\)/);
        const { TICKS } = require('../../src/jobs');
        expect(TICKS.some((t) => /watchdog/.test(t.name))).toBe(false);
    });
});

describe('the health page never shows an absence of measurement as a value', () => {
    const view = read('views/pages/admin/health.ejs');
    const fr = require('../../locales/fr/admin.json');
    const en = require('../../locales/en/admin.json');

    test('every admin:health_* key the view uses exists in FR and EN', () => {
        const keys = [...view.matchAll(/__\('admin:(health_[a-z_0-9]+)'/g)].map((m) => m[1]);
        expect(keys.length).toBeGreaterThan(50);
        const missing = [...new Set(keys)].filter((k) => !(k in fr) || !(k in en));
        expect(missing).toEqual([]);
    });

    test('the page title key exists in both chrome files', () => {
        expect(require('../../locales/fr/chrome.json').pt_health).toBeTruthy();
        expect(require('../../locales/en/chrome.json').pt_health).toBeTruthy();
    });

    test('unmeasured values render as an em dash, never 0', () => {
        expect(view).toMatch(
            /var mb = function \(b\) \{ return \(b == null \|\| !Number\.isFinite\(Number\(b\)\)\) \? '—'/
        );
        expect(view).toMatch(/var dur = function \(ms\) \{ return ms == null \? '—'/);
        expect(view).toMatch(/database\.systemLogs != null \? database\.systemLogs : '—'/);
    });

    test('dates go through the shared formatter, not toLocaleString (L4-16)', () => {
        expect(view).toMatch(/typeof fmtDateTime === 'function'/);
    });
});

describe('HealthController — the page, the buttons and their audit', () => {
    const src = read('src/controllers/HealthController.js');

    test('the cron summary helper never breaks the block comment it documents', () => {
        // The trap that killed the previous run: a cron pattern quoted inside a
        // block comment terminates it. Every line that quotes one must be a // line.
        src.split('\n').forEach((line) => {
            if (line.includes('*/15')) expect(line.trim().startsWith('//')).toBe(true);
        });
        const HealthController = require('../../src/controllers/HealthController');
        expect(HealthController.scheduleOf({ cron: '*/15 * * * *' })).toEqual({
            kind: 'every',
            minutes: 15,
        });
        expect(HealthController.scheduleOf({ cron: '40 * * * *' })).toEqual({
            kind: 'hourly',
            minute: 40,
        });
        expect(HealthController.scheduleOf({ cron: '0 3 * * 1' })).toEqual({
            kind: 'cron',
            cron: '0 3 * * 1',
        });
    });

    test('a manual run and a forced backup are attributed in the audit trail', () => {
        expect(src).toMatch(/const actorRef = `admin:\$\{req\.user\.id\}`/);
        expect(src).toMatch(/action: 'JOB_RUN_MANUAL'/);
        expect(src).toMatch(/action: r\.done \? 'BACKUP_MANUAL_OK' : 'BACKUP_MANUAL_FAILED'/);
        expect(src).toMatch(/backupJob\.tick\(\{ force: true \}\)/);
    });

    test('an unknown tick is refused, not run', () => {
        expect(src).toMatch(/if \(!tick\) \{[\s\S]*health_unknown_tick/);
        expect(src).toMatch(/return res\.status\(404\)\.json\(\{ error: 'unknown_tick' \}\)/);
    });

    test('the routes are SuperAdmin-only (the page runs jobs and writes backups)', () => {
        const routes = read('src/routes/index.js');
        [
            '/admin/health',
            '/admin/health/history/:tick',
            '/admin/health/run/:tick',
            '/admin/health/backup',
        ]
            // `\s*` after the paren and after the path's comma: prettier puts
            // the path and each guard on their own line once the registration
            // overflows, and pinning the one-line spelling failed on routes
            // that were still SuperAdmin-only.
            .forEach((r) =>
                expect(routes).toMatch(
                    new RegExp(
                        `router\\.(get|post)\\(\\s*'${r.replace(/[/:]/g, '\\$&')}',\\s*requireSuperAdmin`
                    )
                )
            );
    });

    test('/about reuses the same migration reader (L4-17) instead of a second rule', () => {
        const routes = read('src/routes/index.js');
        expect(routes).toMatch(/HealthController\.migrationsState\(\)/);
        expect(routes).toMatch(/pg_database_size\(current_database\(\)\)/);
    });
});
