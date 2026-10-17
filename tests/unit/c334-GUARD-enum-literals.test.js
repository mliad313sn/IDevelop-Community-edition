'use strict';
/**
 * Guard — SQL literals against the CHECK and enum value sets of the database.
 *
 * Why: a string literal compared with a constrained column, but outside the
 * values that column may hold, is a query that can never match, and nothing
 * else in the stack reports it. Two such queries were live: the department
 * brief counted 9-box placements « awaiting approval » with
 * `nb.status = 'submitted'` (the CHECK says draft | under_review | approved |
 * rejected | archived, so the section was always empty), and the leaver
 * leftovers listed goals NOT IN ('completed', 'cancelled', 'archived') while
 * a finished goal is 'done'.
 *
 * What: every enum type and single-column CHECK IN-list is read from the test
 * database (pg_enum / pg_constraint); without one the suite is skipped. Every SQL literal in src/ of the form `col = 'x'`,
 * `col IN ('a', 'b')`, `col <> 'x'` or `INSERT … VALUES ('x')` whose column is
 * constrained in one of the statement's tables (FROM / JOIN / UPDATE / INTO
 * after the compatibility rewrite) must belong to that column's set.
 *
 * Exceptions: tests/helpers/guards/allowlist.json → enumLiterals
 * (file, col, literal, reason).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
jest.setTimeout(120000);

const { loadSchema, hasTestDb } = require('../helpers/guards/schema');
const S = require('../helpers/guards/scans');
const A = require('../helpers/guards/allowlist');

const db = hasTestDb() ? require('../../src/config/database') : null;
let schema;
let found; // every mismatch on this tree, allow-list applied

const fmt = (m) =>
    `${m.file}:${m.line} ${m.tables.join('|')}.${m.col} = '${m.literal}' (allowed: ${m.allowed.join('|')})`;

// The value sets are read from the test database (see helpers/guards/schema.js).
const suite = db ? describe : describe.skip;

beforeAll(async () => {
    if (!db) return;
    await db.connect();
    schema = await loadSchema(db);
    found = S.enumLiteralMismatches(schema).filter(
        (m) => !A.allowed('enumLiterals', { file: m.file, col: m.col, literal: m.literal })
    );
});
afterAll(async () => {
    if (db) await db.close();
});

suite('SQL literals vs CHECK / enum value sets', () => {
    test('schema loaded (database or SQL files) with value sets', () => {
        const sets = schema.valueSets();
        const n = Object.values(sets).reduce((a, c) => a + Object.keys(c).length, 0);
        expect(n).toBeGreaterThan(150);
        expect(schema.source).toBe('db');
    });

    test('allow-list entries all carry a reason', () => {
        expect(A.unreasoned('enumLiterals')).toEqual([]);
    });

    test('no literal outside its column value set', () => {
        expect(found.map(fmt)).toEqual([]);
    });

    test("regression: the brief's 9-box section counts 'under_review', the goals CHECK has no 'completed'", () => {
        const sets = schema.valueSets();
        expect([...sets.nine_box_evaluations.status]).toEqual(
            expect.arrayContaining(['draft', 'under_review', 'approved'])
        );
        expect(sets.nine_box_evaluations.status.has('submitted')).toBe(false);
        expect(sets.goals.status.has('done')).toBe(true);
        expect(sets.goals.status.has('completed')).toBe(false);
    });

    test('regression: notifications are addressed to an admin or an employee, never a « manager »', () => {
        const sets = schema.valueSets();
        expect([...sets.notifications.user_type].sort()).toEqual(['admin', 'employee']);
        expect(
            found.filter((m) => m.tables.includes('notifications') && m.col === 'user_type')
        ).toEqual([]);
    });

    test('mutation self-check: a wrong literal in a statement with table context is reported', () => {
        const fake = {
            ...schema,
            valueSets: () => ({ goals: { status: new Set(['active', 'done']) } }),
            tables: { goals: { columns: { status: { type: 'text' } }, checks: [] } },
        };
        const hits = S.enumLiteralMismatches(fake);
        // the real tree compares goals.status with 'at_risk' (OneOnOneService),
        // which this reduced set does not allow: the scanner must say so
        expect(hits.some((h) => h.col === 'status' && h.literal === 'at_risk')).toBe(true);
    });
});
