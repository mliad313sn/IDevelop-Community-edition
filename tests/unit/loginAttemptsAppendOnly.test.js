'use strict';
/**
 * ZDB-5 — login_attempts is append-only: a success never erases the failures
 * before it.
 *
 * Measured on the test base (transaction rolled back): three failures, then a
 * success + clearFailedAttempts (what rateLimiter does on every login) → zero
 * failure rows left. The trace of a brute force that SUCCEEDED was gone.
 *
 * Rule: the lock counts failures inside the window AND after the last success
 * or administrative reset; nothing is deleted. An unlock is a `kind = 'reset'`
 * marker (successful NULL, no address) that no `successful = true/false`
 * predicate can mistake for a login.
 *
 * Part 1 is DB-free. Part 2 runs the real statements, rolled back, when
 * LIVE_DB_TESTS=1 (needs migration 134).
 */
const path = require('path');

describe('LoginAttemptModel (DB-free)', () => {
    let db, LA;
    beforeEach(() => {
        jest.resetModules();
        jest.doMock('../../src/config/database', () => ({
            run: jest.fn().mockResolvedValue({ changes: 1 }),
            get: jest.fn().mockResolvedValue({ count: 0 }),
            all: jest.fn().mockResolvedValue([]),
        }));
        db = require('../../src/config/database');
        LA = require('../../src/models/LoginAttemptModel');
    });

    test('clearFailedAttempts APPENDS a reset marker — it never deletes', async () => {
        await LA.clearFailedAttempts('alice');
        expect(db.run).toHaveBeenCalledTimes(1);
        const [sql, params] = db.run.mock.calls[0];
        expect(sql).not.toMatch(/DELETE/i);
        expect(sql).toMatch(/INSERT INTO login_attempts/);
        expect(sql).toMatch(/'reset'/);
        expect(params).toEqual(['alice']);
    });

    test('the lock count is bounded by the last success or reset of that username', async () => {
        await LA.getFailedAttemptsCount('alice', 15);
        const [sql, params] = db.get.mock.calls[0];
        expect(sql).toMatch(/successful = \?/);
        expect(sql).toMatch(
            /MAX\(l2\.attemptedAt\)[\s\S]*l2\.successful = true OR l2\.kind = 'reset'/
        );
        expect(sql).toMatch(/'-infinity'::timestamptz/);
        // window minutes, then the username again for the boundary sub-select
        expect(params).toEqual(['alice', false, 15, 'alice']);
    });

    test('the only DELETE left is the 7-day retention prune', async () => {
        await LA.cleanupOldAttempts();
        expect(String(db.run.mock.calls[0][0])).toMatch(
            /DELETE FROM login_attempts WHERE attemptedAt < now\(\) - interval '7 days'/
        );
    });
});

describe('EmployeeModel — the "locked" state uses the same boundary', () => {
    test('failed_attempts counts only failures after the last success/reset', () => {
        const fs = require('fs');
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/models/EmployeeModel.js'),
            'utf8'
        );
        const i = src.indexOf('AS failed_attempts');
        expect(i).toBeGreaterThan(-1);
        const block = src.slice(Math.max(0, i - 900), i);
        expect(block).toMatch(/l2\.successful\s*=\s*true\s+OR\s+l2\.kind\s*=\s*'reset'/);
        expect(block).toMatch(/'-infinity'::timestamptz/);
    });
});

const LIVE = process.env.LIVE_DB_TESTS === '1';
(LIVE ? describe : describe.skip)('LoginAttemptModel — real SQL, rolled back', () => {
    let db, LA;
    beforeAll(async () => {
        jest.resetModules();
        jest.dontMock('../../src/config/database');
        require('dotenv').config({ path: path.join(__dirname, '../../.env') });
        db = require('../../src/config/database');
        LA = require('../../src/models/LoginAttemptModel');
        await db.connect();
    });
    afterAll(async () => {
        await db.close();
    });

    test('failures survive a success; the lock lifts; a reset lifts it too', async () => {
        const u = 'jest.zdb5';
        await expect(
            db.runTransaction(async () => {
                for (let i = 0; i < 3; i++) await LA.recordFailedAttempt(u, '127.0.0.1');
                expect(Number(await LA.getFailedAttemptsCount(u, 15))).toBe(3);
                await LA.recordSuccessfulLogin(u, '127.0.0.1');
                await LA.clearFailedAttempts(u);
                expect(Number(await LA.getFailedAttemptsCount(u, 15))).toBe(0);
                const kept = await db.get(
                    'SELECT COUNT(*)::int AS n FROM login_attempts WHERE username = ? AND successful = false',
                    [u]
                );
                expect(kept.n).toBe(3);
                // a new failure after the success counts again from 1
                await LA.recordFailedAttempt(u, '127.0.0.1');
                expect(Number(await LA.getFailedAttemptsCount(u, 15))).toBe(1);
                // administrative reset (no login) lifts it as well
                await LA.clearFailedAttempts(u);
                expect(Number(await LA.getFailedAttemptsCount(u, 15))).toBe(0);
                const marker = await db.get(
                    "SELECT successful, ip_address, kind FROM login_attempts WHERE username = ? AND kind = 'reset' ORDER BY attempted_at DESC LIMIT 1",
                    [u]
                );
                expect(marker.successful).toBeNull();
                expect(marker.ipAddress).toBeNull();
                // the reset is invisible to "last login" and "failures" predicates
                const seen = await db.get(
                    "SELECT COUNT(*)::int AS n FROM login_attempts WHERE username = ? AND (successful = true OR successful = false) AND kind = 'reset'",
                    [u]
                );
                expect(seen.n).toBe(0);
                throw new Error('__ROLLBACK__');
            })
        ).rejects.toThrow('__ROLLBACK__');
    });
});
