'use strict';
/**
 * Safety net of tests/helpers/dbSuiteEnvironment.js.
 *
 * A suite the environment did not detect statically (no `.connect()` in its
 * source) but that still connects the real db module takes the cross-worker
 * DB-suite lock at connect time, before its first query. Mocked db modules
 * (jest.mock('../../src/config/database')) never reach this code. Nothing is
 * wrapped when no test database is configured.
 */
const lock = globalThis.__dbSuiteLock;

// A detected DB-backed suite gets a 60 s default per test and hook instead of
// jest's 5 s: its first query pays plan and cache warm-up, and under a parallel
// run it shares the CPU with the other workers. A suite's own jest.setTimeout(...)
// or per-test timeout still wins (it runs after this file).
const DB_SUITE_TIMEOUT_MS = 60000;
if (lock && lock.held()) jest.setTimeout(DB_SUITE_TIMEOUT_MS);

if (lock && lock.enabled()) {
    const PostgresDatabase = require('../../src/database/PostgresDatabase');
    const proto = PostgresDatabase && PostgresDatabase.prototype;
    if (proto && typeof proto.connect === 'function' && !proto.connect.__dbSuiteLocked) {
        const original = proto.connect;
        const wrapped = async function connect(...args) {
            if (!lock.held()) await lock.acquire('late: PostgresDatabase#connect');
            return original.apply(this, args);
        };
        wrapped.__dbSuiteLocked = true;
        proto.connect = wrapped;
    }
}

// Every notification kind a suite makes NotificationService write must be
// declared in src/services/notificationCatalogue.js. The service collects an
// undeclared kind under the test runner (NotificationService._checkDeclared);
// the suite that emitted it fails here, whatever it was testing.
afterAll(() => {
    const undeclared = globalThis.__undeclaredNotificationKinds;
    if (undeclared && undeclared.size) {
        const list = [...undeclared].sort().join(', ');
        undeclared.clear();
        throw new Error(
            `notification kind(s) emitted but not declared in src/services/notificationCatalogue.js: ${list}`
        );
    }
});
