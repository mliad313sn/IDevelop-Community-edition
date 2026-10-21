'use strict';
/**
 * One DB-backed suite at a time, across jest workers.
 *
 * `npm run test:unit` (plain `jest`) runs the suites on parallel workers. The
 * suites that talk to the REAL test database plant rows, run migration DDL
 * inside a rolled-back transaction, update employees and admins, or scan every
 * table. Two of them running at the same moment lock the same rows or tables in
 * a different order and PostgreSQL kills one of them ("deadlock detected"): a
 * different suite on each run, each green on its own.
 *
 * This environment serialises exactly those suites with a cross-process
 * PostgreSQL advisory lock, held on a dedicated connection for the whole test
 * file (taken in setup(), released in teardown(), so no hook timeout applies),
 * while pure unit suites keep running in parallel. `npm test` (--runInBand)
 * behaves exactly as before: one suite at a time, and the lock is never
 * contended.
 *
 *  - A suite is DB-backed when its source calls `<something>.connect()` (the db
 *    module must be connected before any query). This is decided before it runs.
 *  - Safety net: tests/helpers/dbSuiteLockSetup.js wraps PostgresDatabase#connect,
 *    so a suite that connects without having been detected takes the lock at
 *    that moment (and says so on stderr).
 *  - Only a test database is ever locked (tests/helpers/testDatabase.js: the
 *    parsed database NAME, `idevelop_test*`, `idevelop_fixtures*` or `*_test`).
 *    With no test database configured this is the plain environment.
 *
 * It extends NativeEsmEnvironment, so `__nativeRequire` stays available.
 */
const fs = require('fs');
const path = require('path');
const NativeEsmEnvironment = require('./nativeEsmEnvironment');
const { isTestDatabaseUrl } = require('./testDatabase');

const LOCK_KEY = 732323; // arbitrary and constant: the "jest DB suite" mutex
const DETECT = /\.connect\(\s*\)/;

function testDatabaseUrl() {
    let url = process.env.DATABASE_URL;
    if (!url) {
        try {
            const envFile = path.join(__dirname, '..', '..', '.env');
            url = require('dotenv').parse(fs.readFileSync(envFile)).DATABASE_URL;
        } catch (_) {
            url = null;
        }
    }
    return url && isTestDatabaseUrl(url) ? url : null;
}

class DbSuiteEnvironment extends NativeEsmEnvironment {
    constructor(config, context) {
        super(config, context);
        this.testPath = context.testPath;
        this.lockClient = null;
        this.lockPromise = null;
        this.global.__dbSuiteLock = {
            acquire: (why) => this.acquire(why),
            held: () => !!this.lockClient,
            enabled: () => !!testDatabaseUrl(),
        };
    }

    async setup() {
        await super.setup();
        let src = '';
        try {
            src = fs.readFileSync(this.testPath, 'utf8');
        } catch (_) {
            src = '';
        }
        if (DETECT.test(src)) await this.acquire('static');
    }

    acquire(why) {
        if (this.lockPromise) return this.lockPromise;
        const url = testDatabaseUrl();
        if (!url) return Promise.resolve(false);
        if (why !== 'static')
            process.stderr.write(
                `[dbSuiteLock] ${path.basename(this.testPath)} connected to the test DB ` +
                    `without being detected; lock taken late (${why}).\n`
            );
        this.lockPromise = (async () => {
            const { Client } = require('pg');
            const client = new Client({
                connectionString: url,
                application_name: 'jest-db-suite-lock',
            });
            try {
                await client.connect();
                // waiting for the lock may take minutes: no server-side timeout on this session
                await client.query('SET statement_timeout = 0; SET lock_timeout = 0');
                await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
                this.lockClient = client;
                return true;
            } catch (e) {
                // database unreachable: run unlocked, the suite reports its own connection error
                await client.end().catch(() => {});
                process.stderr.write(`[dbSuiteLock] lock not taken (${e.message || e.code}).\n`);
                return false;
            }
        })();
        return this.lockPromise;
    }

    async teardown() {
        try {
            if (this.lockPromise) await this.lockPromise.catch(() => {});
            if (this.lockClient) {
                // ending the session releases the session-level advisory lock
                await this.lockClient.end().catch(() => {});
                this.lockClient = null;
            }
        } finally {
            await super.teardown();
        }
    }
}

module.exports = DbSuiteEnvironment;
module.exports.LOCK_KEY = LOCK_KEY;
module.exports.DETECT = DETECT;
