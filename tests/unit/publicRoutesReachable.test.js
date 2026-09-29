'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * Self-service password reset was UNREACHABLE by the only people it exists for.
 *
 * `src/routes/index.js` applies `router.use(requireAuth)` once, and everything
 * mounted after it is authenticated. The four forgot/reset routes sat roughly
 * 300 lines BELOW that line — carrying a comment that read "Public
 * (logged-out)". Logged out:
 *
 *   GET  /forgot-password              -> 302 /login
 *   GET  /reset-password?token=...     -> 302 /login
 *   POST /forgot-password              -> 403
 *
 * The service layer underneath was correct in every respect — hashed-at-rest
 * CSPRNG token, 30-minute TTL, single-use, replay refused, sessions revoked,
 * anti-enumeration, link built from server config and never the Host header —
 * which is exactly why this survived: nothing failed loudly, and verifying the
 * service in isolation "passed" while the feature was locked from the inside.
 * A service being correct does not make a feature reachable.
 *
 * After moving them above the gate, verified over real HTTP with no session:
 *
 *   GET /forgot-password        200, stays on /forgot-password, form present
 *   GET /reset-password         200 (bad token bounces to /forgot-password)
 *   POST known vs unknown       302 / 302, identical — still anti-enumeration
 *
 * These tests read the route table rather than the app so they cost nothing and
 * cannot be skipped by a missing database.
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '../../src/routes/index.js'), 'utf8');
const GATE = SRC.indexOf('router.use(requireAuth);');

describe('the authentication gate exists exactly once', () => {
    test('there is a single blanket requireAuth mount', () => {
        expect(GATE).toBeGreaterThan(-1);
        const all = [...SRC.matchAll(/router\.use\(requireAuth\);/g)];
        expect(all).toHaveLength(1);
    });
});

describe('password reset is reachable without a session', () => {
    test.each([
        ["router.get('/forgot-password'", 'the request form'],
        ["router.post('/forgot-password'", 'submitting an identifier'],
        ["router.get('/reset-password'", 'the tokened form'],
        ["router.post('/reset-password'", 'setting the new password'],
    ])('%s is mounted BEFORE the gate (%s)', (needle) => {
        const at = SRC.indexOf(needle);
        expect(at).toBeGreaterThan(-1);
        expect(at).toBeLessThan(GATE);
    });

    test('the POSTs are still rate-limited', () => {
        expect(SRC).toMatch(/router\.post\('\/forgot-password', loginRateLimiter/);
        expect(SRC).toMatch(/router\.post\('\/reset-password', loginRateLimiter/);
    });

    test('why they must stay above the gate is recorded next to them', () => {
        const block = SRC.slice(
            Math.max(0, SRC.indexOf("router.get('/forgot-password'") - 900),
            SRC.indexOf("router.get('/forgot-password'")
        );
        expect(block).toMatch(/MUST stay above/i);
    });
});

describe('changing your password while signed in stays protected', () => {
    test('/change-password is still behind the gate', () => {
        // The fix moved the RESET routes only. Change-password is for someone who
        // is already authenticated and must not become public.
        expect(SRC.indexOf("router.get('/change-password'")).toBeGreaterThan(GATE);
        expect(SRC.indexOf("router.post('/change-password'")).toBeGreaterThan(GATE);
    });
});

describe('no other route claims to be public from behind the gate', () => {
    test('every route whose own comment says public/logged-out is mounted before it', () => {
        const lines = SRC.split('\n');
        const gateLine = lines.findIndex((l) => l.includes('router.use(requireAuth);'));
        const offenders = [];
        for (let i = gateLine + 1; i < lines.length; i++) {
            if (!/^router\.(get|post|put|patch|delete)\(/.test(lines[i].trim())) continue;
            // Look back over the comment block immediately above this route.
            let j = i - 1;
            const comment = [];
            while (j >= 0 && /^\s*(\/\/|\*|\/\*)/.test(lines[j])) {
                comment.unshift(lines[j]);
                j--;
            }
            const text = comment.join(' ');
            if (
                /\bpublic\b|logged[- ]out|unauthenticated/i.test(text) &&
                // "Public path" notes on API-key-authed mounts are a different thing:
                // they authenticate by key, not by session.
                !/API[- ]key|SCIM|LMS|callback/i.test(text)
            ) {
                offenders.push(`${i + 1}: ${lines[i].trim().slice(0, 70)}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});
