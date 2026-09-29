'use strict';
/**
 * ZDB-4 — the jsonb `?` operators must survive placeholder translation.
 *
 * Measured on the test base: the lifecycle register's state filter
 *     NOT (le.payload ? 'skipped')
 * was rewritten to `payload $1 'skipped'` and GET /v2/lifecycle?state=done
 * (and ?state=skipped) answered a 500 page — 42601 "syntax error at or near
 * $1". The same statement with native `$n` placeholders returned 15 rows.
 *
 * Rule: a `?` is a value placeholder only where a value can stand. `?|` and
 * `?&` are operators outright; a `?` followed by a string literal is the
 * key-exists operator, because two adjacent values are not SQL.
 */
const { translatePlaceholders } = require('../../src/database/sql-compat');

describe('translatePlaceholders — jsonb operators pass through', () => {
    test("`payload ? 'key'` is the key-exists operator, not a placeholder", () => {
        const sql = `SELECT 1 FROM lifecycle_events le WHERE le.kind = ? AND NOT (le.payload ? 'skipped')`;
        expect(translatePlaceholders(sql)).toBe(
            `SELECT 1 FROM lifecycle_events le WHERE le.kind = $1 AND NOT (le.payload ? 'skipped')`
        );
    });

    test('the exact STATE_SQL shapes of v2-lifecycle translate to valid SQL', () => {
        const done = `le.processed_at IS NOT NULL AND le.reverted_at IS NULL AND NOT (le.payload ? 'skipped') AND COALESCE(le.decision, '') <> 'declined'`;
        const skipped = `le.processed_at IS NOT NULL AND le.reverted_at IS NULL AND (le.payload ? 'skipped')`;
        expect(translatePlaceholders(done)).toBe(done);
        expect(translatePlaceholders(skipped)).toBe(skipped);
    });

    test('a placeholder AFTER the operator still gets the right number', () => {
        const sql = `WHERE le.kind = ? AND (le.payload ? 'skipped') AND e.site_id = ?`;
        expect(translatePlaceholders(sql)).toBe(
            `WHERE le.kind = $1 AND (le.payload ? 'skipped') AND e.site_id = $2`
        );
    });

    test('`?|` and `?&` (any / all keys) are never translated', () => {
        expect(translatePlaceholders(`WHERE j ?| array['a','b'] AND x = ?`)).toBe(
            `WHERE j ?| array['a','b'] AND x = $1`
        );
        expect(translatePlaceholders(`WHERE j ?& array['a','b'] AND x = ?`)).toBe(
            `WHERE j ?& array['a','b'] AND x = $1`
        );
    });

    test('whitespace before the literal does not change the verdict', () => {
        expect(translatePlaceholders(`WHERE j ?\n  'k'`)).toBe(`WHERE j ?\n  'k'`);
    });

    test('ordinary placeholders are untouched by the rule', () => {
        expect(
            translatePlaceholders(
                `SELECT * FROM t WHERE a = ? AND b IN (?, ?) AND c = ?::risk_level`
            )
        ).toBe(`SELECT * FROM t WHERE a = $1 AND b IN ($2, $3) AND c = $4::risk_level`);
    });

    test('a `?` inside a string literal is still a character', () => {
        expect(translatePlaceholders(`SELECT 'is it ?' WHERE x = ?`)).toBe(
            `SELECT 'is it ?' WHERE x = $1`
        );
    });
});
