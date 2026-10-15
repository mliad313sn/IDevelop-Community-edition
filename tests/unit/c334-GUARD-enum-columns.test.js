'use strict';
/**
 * Guard — enum-like text columns are constrained, or allow-listed with a reason.
 *
 * Why: a status / kind / type column without a CHECK or an enum type drifts:
 * two spellings of the same value appear, a reader matches one of them, and
 * half the rows disappear from a filter. The system log carries exactly that
 * history (nine_box / nineBox, self_assessment / selfAssessment…), written
 * before the canonical writer of migration 112.
 *
 * What (schema from the test database; skipped without one):
 *  (a) every text column whose name looks like an enum (…status, state, kind,
 *      type, category, source, …) with NO enum type and NO single-column CHECK
 *      IN-list, and 1 to 12 distinct literals WRITTEN to it by src/ (INSERT …
 *      VALUES / UPDATE … SET with table context, plus `col: 'x'` object keys
 *      in files that name the table), must be allow-listed with the reason it
 *      stays open (allowlist.json → unconstrainedColumns: table?, col, reason).
 *      A column with no literal written is reported, not judged.
 *  (b) the live distinct values of those columns must not
 *      collide once lower-cased and stripped of `_ -` (two spellings of one
 *      value); the system log's legacy spellings are history, allow-listed one
 *      by one (allowlist.json → legacySpellings), and nothing legacy may be
 *      written after the canonical spelling first appears.
 *  (c) no CHECK / enum value is spelled with a hyphen where its underscore twin
 *      exists in another value set (allowlist.json → hyphenValues).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
jest.setTimeout(240000);

const { loadSchema, hasTestDb } = require('../helpers/guards/schema');
const S = require('../helpers/guards/scans');
const A = require('../helpers/guards/allowlist');

const db = hasTestDb() ? require('../../src/config/database') : null;
let schema;
let cols; // unconstrained enum-like columns with their written literals

const SYSTEM_LOG = { table: 'system_logs', col: 'entity_type' };

// The value sets are read from the test database (see helpers/guards/schema.js).
const suite = db ? describe : describe.skip;

beforeAll(async () => {
    if (!db) return;
    await db.connect();
    schema = await loadSchema(db);
    cols = S.unconstrainedEnumColumns(schema);
});
afterAll(async () => {
    if (db) await db.close();
});

const fmt = (c) =>
    `${c.table}.${c.col} has no CHECK/enum but the code writes ${c.literals.length} literal(s): ${c.literals.join(' | ')}`;
const isAllowed = (c) => A.allowed('unconstrainedColumns', { table: c.table, col: c.col });

suite('(a) enum-like text columns written with 12 literals or fewer', () => {
    test('allow-list entries all carry a reason', () => {
        expect(A.unreasoned('unconstrainedColumns')).toEqual([]);
    });
    test('no unconstrained column outside the allow-list', () => {
        const bad = cols.filter(
            (c) => c.literals.length >= 1 && c.literals.length <= 12 && !isAllowed(c)
        );
        expect(bad.map(fmt)).toEqual([]);
    });
    test('regression: opportunity_applications.status carries its CHECK', () => {
        const sets = schema.valueSets();
        expect([...sets.opportunity_applications.status].sort()).toEqual([
            'accepted',
            'applied',
            'declined',
            'withdrawn',
        ]);
        expect(cols.find((x) => x.table === 'opportunity_applications')).toBeUndefined();
    });
    test('report: unconstrained enum-like columns with no literal written (nothing to judge)', () => {
        const silent = cols
            .filter((c) => c.literals.length === 0)
            .map((c) => `${c.table}.${c.col}`);
        expect(Array.isArray(silent)).toBe(true);
    });
});

suite('(b) live spelling variants of unconstrained enum-like columns', () => {
    let variants;
    beforeAll(async () => {
        variants = [];
        if (!schema.liveValues) return;
        for (const c of cols) {
            const live = await schema.liveValues(c.table, c.col);
            const vals = live.map((x) => x[0]).filter((x) => x !== null);
            const norm = new Map();
            for (const v of vals) {
                const k = String(v)
                    .toLowerCase()
                    .replace(/[\s_-]/g, '');
                (norm.get(k) || norm.set(k, []).get(k)).push(v);
            }
            const split = [...norm.values()].filter((g) => g.length > 1);
            if (split.length) variants.push({ table: c.table, col: c.col, split });
        }
    });
    test('no split outside the system log', () => {
        const bad = variants.filter(
            (v) => !(v.table === SYSTEM_LOG.table && v.col === SYSTEM_LOG.col)
        );
        expect(
            bad.map((v) => `${v.table}.${v.col}: ${v.split.map((g) => g.join('/')).join(', ')}`)
        ).toEqual([]);
    });
    // The system log is append-only and hash-chained: its historic spellings are
    // never rewritten. The writer is canonical since migration 112
    // (LogService.normalizeEntityType) and every reader matches each spelling
    // (SystemLogModel.entityTypeVariants). The guard: every legacy spelling is
    // allow-listed, and no legacy row is newer than the latest canonical one.
    test('system_logs.entity_type: legacy spellings are allow-listed history, nothing legacy written since', async () => {
        expect(A.unreasoned('legacySpellings')).toEqual([]);
        const v = variants.find((x) => x.table === SYSTEM_LOG.table && x.col === SYSTEM_LOG.col);
        const problems = [];
        for (const group of v ? v.split : []) {
            const legacy = group.filter((x) =>
                A.allowed('legacySpellings', {
                    table: SYSTEM_LOG.table,
                    col: SYSTEM_LOG.col,
                    value: x,
                })
            );
            const canonical = group.filter((x) => !legacy.includes(x));
            if (canonical.length !== 1) {
                problems.push(
                    `${group.join('/')}: ${canonical.length} spelling(s) not allow-listed as legacy (expected exactly 1 canonical)`
                );
                continue;
            }
            const r = await db.get(
                `SELECT MAX(created_at) FILTER (WHERE entity_type = ANY(?)) AS "lastLegacy",
                        MAX(created_at) FILTER (WHERE entity_type = ?) AS "lastCanonical"
                   FROM system_logs WHERE entity_type = ANY(?)`,
                [legacy, canonical[0], group]
            );
            if (!r.lastCanonical)
                problems.push(
                    `${group.join('/')}: no row under the canonical spelling ${canonical[0]}`
                );
            else if (
                r.lastLegacy &&
                new Date(r.lastLegacy).getTime() >= new Date(r.lastCanonical).getTime()
            )
                problems.push(
                    `${group.join('/')}: a legacy row (${r.lastLegacy}) was written after the canonical one (${r.lastCanonical})`
                );
        }
        expect(problems).toEqual([]);
    });
    test('mutation self-check: a legacy spelling is allow-listed, the canonical one is not', () => {
        const probe = (value) =>
            A.allowed('legacySpellings', { table: 'system_logs', col: 'entity_type', value });
        expect(probe('nineBox')).toBe(true);
        expect(probe('nine_box')).toBe(false);
    });
    test('every legacy spelling is a synonym the system-log reader already matches', () => {
        const SystemLogModel = require('../../src/models/SystemLogModel');
        for (const e of A.section('legacySpellings')) {
            const variantsOf = SystemLogModel.entityTypeVariants(e.value);
            expect(variantsOf.length).toBeGreaterThan(1);
            expect(variantsOf).toContain(e.value);
        }
    });
});

suite('(c) hyphen / underscore spelling of CHECK and enum values', () => {
    let hyphens;
    beforeAll(() => {
        const sets = schema.valueSets();
        const all = new Set();
        for (const t of Object.values(sets))
            for (const s of Object.values(t)) for (const v of s) all.add(v);
        hyphens = [];
        for (const [table, c] of Object.entries(sets))
            for (const [col, s] of Object.entries(c))
                for (const v of s)
                    if (v.includes('-') && all.has(v.replace(/-/g, '_')))
                        hyphens.push({ table, col, value: v });
    });
    const isAllowedHyphen = (h) =>
        A.allowed('hyphenValues', { table: h.table, col: h.col, value: h.value });
    test('allow-listed hyphen values all carry a reason', () => {
        expect(A.unreasoned('hyphenValues')).toEqual([]);
    });
    test('no hyphenated twin outside the allow-list', () => {
        expect(
            hyphens
                .filter((h) => !isAllowedHyphen(h))
                .map((h) => `${h.table}.${h.col} '${h.value}'`)
        ).toEqual([]);
    });
    test('mutation self-check: the underscore spelling is not allow-listed', () => {
        expect(
            A.allowed('hyphenValues', {
                table: 'training_plan_items',
                col: 'status',
                value: 'in_progress',
            })
        ).toBe(false);
    });
});
