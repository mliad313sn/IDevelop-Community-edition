'use strict';
/**
 * Regression tests for the v3.22.3 scheduler-drift bug: the telemetry-prune
 * tick existed only in the in-process setInterval path, so under REDIS_URL
 * (BullMQ) it silently never ran. Both runtimes now iterate the shared TICKS
 * registry in src/jobs/index.js — these tests pin that a tick can never be
 * registered in one path only.
 *
 * DB-free: bullmq/ioredis/database and every tick target are mocked.
 */

jest.mock('bullmq', () => {
    class FakeQueue {
        constructor(name) {
            this.name = name;
            this.added = [];
            FakeQueue.instances.push(this);
        }
        add(jobName, data, opts) {
            this.added.push({ jobName, opts });
            return Promise.resolve();
        }
        close() {
            return Promise.resolve();
        }
    }
    FakeQueue.instances = [];
    class FakeWorker {
        constructor(name, processor) {
            this.name = name;
            this.processor = processor;
            FakeWorker.instances.push(this);
        }
        close() {
            return Promise.resolve();
        }
    }
    FakeWorker.instances = [];
    class FakeQueueEvents {}
    return { Queue: FakeQueue, Worker: FakeWorker, QueueEvents: FakeQueueEvents };
});

jest.mock(
    'ioredis',
    () =>
        class FakeRedis {
            constructor() {}
        }
);

jest.mock('../../src/config/database', () => ({
    pool: {
        connect: async () => ({
            query: async () => ({ rows: [{ locked: true }] }),
            release: () => {},
        }),
    },
}));

// Tick targets — replaced so no tick touches the DB or optional services.
jest.mock('../../src/jobs/dispute-escalator', () => ({ tick: jest.fn() }));
jest.mock('../../src/jobs/report-scheduler', () => ({ tick: jest.fn() }));
jest.mock('../../src/jobs/fit-history', () => ({ tick: jest.fn() }));
jest.mock('../../src/jobs/manager-digest', () => ({ tick: jest.fn() }));
jest.mock('../../src/jobs/db-backup', () => ({ tick: jest.fn() }));
jest.mock('../../src/jobs/telemetry-prune', () => ({ tick: jest.fn() }));
jest.mock('../../src/services/NotificationService', () => ({ releaseSnoozed: jest.fn() }));
jest.mock('../../src/services/LmsService', () => ({ runScheduledSync: jest.fn() }));
jest.mock('../../src/services/PriorityIndexService', () => ({ refresh: jest.fn() }), {
    virtual: true,
}); // service is OPTIONAL in the registry (try/require/catch) and absent in this build
jest.mock('../../src/services/IDPService', () => ({ generateDrafts: jest.fn(() => 'drafts') }));

const { Queue, Worker } = require('bullmq');
const jobs = require('../../src/jobs/index');

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('TICKS registry — single source of truth for both scheduler runtimes', () => {
    test('contains every time-based tick, including telemetry-prune (the drifted one)', () => {
        const names = jobs.TICKS.map((t) => t.name);
        expect(names).toEqual(
            expect.arrayContaining([
                'dispute-escalator.tick',
                'notifications.release-snoozed',
                'priority-index.refresh',
                'lms.sync.tick',
                'report-scheduler.tick',
                'fit-history.tick',
                'manager-digest.tick',
                'db-backup.tick',
                'telemetry-prune.tick',
            ])
        );
        // No duplicates — one registration per tick per runtime.
        expect(new Set(names).size).toBe(names.length);
    });

    test('every entry is fully specified (fail-fast validation contract)', () => {
        for (const t of jobs.TICKS) {
            expect(typeof t.name).toBe('string');
            expect(typeof t.cron).toBe('string');
            expect(t.everyMin).toBeGreaterThan(0);
            expect(t.keep).toBeGreaterThan(0);
            expect(typeof t.fn).toBe('function');
        }
    });
});

describe('BullMQ path (REDIS_URL set) registers every registry tick', () => {
    let handle;

    beforeAll(() => {
        process.env.REDIS_URL = 'redis://localhost:6379';
        handle = jobs.boot();
    });
    afterAll(() => {
        delete process.env.REDIS_URL;
    });

    test('a repeatable job exists for each TICKS entry with its cron pattern', () => {
        const cycleEvents = Queue.instances.find((q) => q.name === 'cycle-events');
        expect(cycleEvents).toBeDefined();
        const repeatables = cycleEvents.added.filter((a) => a.opts && a.opts.repeat);
        const byName = Object.fromEntries(
            repeatables.map((a) => [a.jobName, a.opts.repeat.pattern])
        );
        for (const t of jobs.TICKS) expect(byName[t.name]).toBe(t.cron);
        expect(repeatables.length).toBe(jobs.TICKS.length);
    });

    test('bootRun ticks also get a one-off job at boot (parity with in-process boot-run)', () => {
        const cycleEvents = Queue.instances.find((q) => q.name === 'cycle-events');
        const oneOffs = cycleEvents.added.filter((a) => !a.opts.repeat).map((a) => a.jobName);
        const expected = jobs.TICKS.filter((t) => t.bootRun).map((t) => t.name);
        expect(expected).toContain('telemetry-prune.tick'); // the drifted tick boot-runs too
        expect(oneOffs.sort()).toEqual(expected.sort());
    });

    test('the cycle-events worker dispatches each registry tick to its fn', async () => {
        const worker = Worker.instances.find((w) => w.name === 'cycle-events');
        expect(worker).toBeDefined();

        await worker.processor({ name: 'telemetry-prune.tick', data: {} });
        expect(require('../../src/jobs/telemetry-prune').tick).toHaveBeenCalled();

        await worker.processor({ name: 'notifications.release-snoozed', data: {} });
        expect(require('../../src/services/NotificationService').releaseSnoozed).toHaveBeenCalled();

        // Event-driven job stays outside the registry but still dispatches.
        const out = await worker.processor({ name: 'cycle.closed', data: { cycleId: 7 } });
        expect(require('../../src/services/IDPService').generateDrafts).toHaveBeenCalledWith(7, {
            locale: undefined,
        });
        expect(out).toBe('drafts');

        // Unknown job names are a no-op, not a crash.
        await expect(worker.processor({ name: 'not-a-tick', data: {} })).resolves.toBeNull();
    });

    test('boot() returned live queues/workers', () => {
        expect(Object.keys(handle.queues).length).toBeGreaterThan(0);
        expect(Object.keys(handle.workers).length).toBeGreaterThan(0);
    });
});

describe('in-process path (no REDIS_URL) registers every registry tick', () => {
    let state;
    // jest.config has clearMocks:true, which wipes mock call records BEFORE each
    // test — anything the boot fired during beforeAll would be invisible to the
    // assertions. Capture the boot-run call counts here instead.
    let bootRunCalls;

    beforeAll(async () => {
        jest.clearAllMocks(); // don't let the BullMQ dispatch test satisfy the boot-run assertion
        delete process.env.REDIS_URL;
        state = jobs.bootInProcess();
        await flush(); // let the async leader-lock IIFE finish registering timers
        await flush();
        bootRunCalls = {
            fitHistory: require('../../src/jobs/fit-history').tick.mock.calls.length,
            telemetryPrune: require('../../src/jobs/telemetry-prune').tick.mock.calls.length,
        };
    });
    afterAll(() => {
        (state.timers || []).forEach((t) => clearInterval(t));
        state.timers.length = 0;
    });

    test('one interval timer per TICKS entry', () => {
        expect(state.timers.length).toBe(jobs.TICKS.length);
    });

    test('bootRun ticks fired once at startup (fit-history + telemetry-prune)', () => {
        expect(bootRunCalls.fitHistory).toBeGreaterThanOrEqual(1);
        expect(bootRunCalls.telemetryPrune).toBeGreaterThanOrEqual(1);
    });
});
