'use strict';
/**
 * CODE-REVIEW-2026-09-17 [IMPORTANT/security]: « Le wrapper d'erreur de
 * /api/v1 renvoie le texte du pilote sans condition d'environnement, et un
 * identifiant non numérique atteint la base en NaN ».
 *
 * Both halves were one defect, and they fed each other:
 *
 *   · `parseInt('abc', 10)` is NaN, and NaN travelled into a bigint column;
 *   · Postgres answered "invalid input syntax for type bigint: NaN";
 *   · the router's `asyncH` caught it and replied
 *     `{ error: 'internal_error', message: e.message }` — with NO environment
 *     gate — so the driver's own text reached the caller.
 *
 * That is exactly the disclosure errorHandler's env gate exists to prevent,
 * on the one surface reachable with nothing but an API key.
 *
 * PROVEN BY EXECUTION over HTTP against a live server on :3199 with a known
 * API key, so the whole stack ran (auth → guard → repository → driver →
 * wrapper). Before the fix, `/api/v1/employees/abc/readiness` answered
 * **500** carrying "invalid input syntax for type bigint"; after it, **400**
 * and nothing from the driver. The same mutation re-run reproduces it.
 *
 * The fix reuses utils/apiErrors, which the product already relies on
 * elsewhere: `requireId` refuses the identifier before any query, and
 * `toResponse` tells an internal fault from a deliberate domain refusal —
 * internal becomes a generic sentence plus the request id, a domain error
 * keeps its exact wording and status.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
const SRC = read('src/api/v1/index.js');

describe('the error wrapper classifies instead of echoing', () => {
    test('asyncH goes through toResponse, not through e.message', () => {
        const i = SRC.indexOf('const asyncH =');
        expect(i).toBeGreaterThan(-1);
        const wrapper = SRC.slice(i, SRC.indexOf('};', i));
        expect(wrapper).toMatch(/toResponse\(e, req, 'api\/v1'\)/);
        // The exact shape that leaked.
        expect(wrapper).not.toMatch(/message: e && e\.message/);
        expect(wrapper).not.toMatch(/error: 'internal_error'/);
    });

    test('it imports the shared classifier rather than re-implementing one', () => {
        expect(SRC).toMatch(/require\('\.\.\/\.\.\/utils\/apiErrors'\)/);
        expect(SRC).toMatch(/\btoResponse\b/);
        expect(SRC).toMatch(/\brequireId\b/);
    });
});

describe('a malformed identifier is refused before the database sees it', () => {
    const guard = SRC.slice(
        SRC.indexOf('const apiEmployeeAccess ='),
        SRC.indexOf('// Per-key write authorization')
    );

    test('the employee guard validates the id', () => {
        expect(guard).toMatch(/requireId\(req\.params\.id, 'id'\)/);
        // The raw parse that produced NaN.
        expect(guard).not.toMatch(/parseInt\(req\.params\.id, 10\)/);
    });

    test('its catch preserves a deliberate status instead of flattening to 500', () => {
        // A blanket 500 here would turn the new 400 into a server fault and
        // hide the caller's own mistake from them.
        expect(guard).toMatch(/toResponse\(e, req, 'api\/v1'\)/);
        expect(guard).not.toMatch(/res\.status\(500\)\.json\(\{ error: 'internal_error' \}\)/);
    });
});

describe('the classifier itself still behaves (it is what the fix leans on)', () => {
    const E = require('../../src/utils/apiErrors');

    test('a driver error becomes a generic sentence, never the SQL text', () => {
        const pg = Object.assign(new Error('invalid input syntax for type bigint: "NaN"'), {
            code: '22P02',
        });
        const { status, body } = E.toResponse(pg, { id: 'r1' }, 'api/v1');
        expect(status).toBe(500);
        expect(JSON.stringify(body)).not.toMatch(/invalid input syntax|bigint|22P02/);
        expect(body.error).toBe(E.GENERIC_FR);
    });

    test('requireId refuses every malformed identifier with a 400', () => {
        for (const bad of ['abc', 'NaN', '-1', '0', '1;DROP', '', null]) {
            let thrown = null;
            try {
                E.requireId(bad, 'id');
            } catch (e) {
                thrown = e;
            }
            expect(thrown).not.toBeNull();
            expect(thrown.status).toBe(400);
        }
        expect(E.requireId('42')).toBe(42);
    });
});
