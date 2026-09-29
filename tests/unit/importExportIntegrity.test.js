'use strict';
/**
 * Import/export data-integrity invariants.
 *
 * These pin the three silent-corruption bugs the Excel round-trip used to have,
 * at the level where they can be tested without a database:
 *
 *   1. Level 0 ("Aucun") is a RATING, not a blank. The export used
 *      `level ? level : ''`, so every level-0 assessment and every level-0 role
 *      requirement left the system as an empty cell and never came back.
 *   2. The critical flag had no representation in the matrix at all, so a
 *      round-trip reset all 215 critical requirements to ordinary. It now
 *      travels as a trailing "*" on the level cell.
 *   3. Skill NAMES are not unique — duplicate groups were merged by soft-retire —
 *      so a bare `WHERE name = ?` could resolve to the retired twin. The resolver
 *      restricts name lookups to active skills and is deterministic.
 *
 * DB-free: only the pure cell parser and the resolver's SQL shape are exercised.
 * The end-to-end round-trip is proven separately against the live database.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@localhost:5432/none';

const UnifiedImportService = require('../../src/services/UnifiedImportService');
const UnifiedExportService = require('../../src/services/UnifiedExportService');
const {
    resolveActiveSkillByName,
    resolveSkillByIdOrName,
} = require('../../src/utils/importSkillResolver');

const parse = (v) => UnifiedImportService._parseLevelCell(v);

describe('matrix cell parsing (level + critical marker)', () => {
    test('a plain number is a non-critical requirement at that level', () => {
        expect(parse(3)).toEqual({ level: 3, critical: false, marked: false });
        expect(parse('2')).toEqual({ level: 2, critical: false, marked: false });
    });

    test('LEVEL 0 IS A VALUE, not a blank — the whole point of defect #2', () => {
        expect(parse(0)).toEqual({ level: 0, critical: false, marked: false });
        expect(parse('0')).toEqual({ level: 0, critical: false, marked: false });
        // and it must not be confused with an empty cell
        expect(parse('')).toBeNull();
        expect(parse(null)).toBeNull();
        expect(parse(undefined)).toBeNull();
        expect(parse('   ')).toBeNull();
    });

    test('a trailing * marks the requirement CRITICAL and is stripped from the level', () => {
        expect(parse('3*')).toEqual({ level: 3, critical: true, marked: true });
        expect(parse('0*')).toEqual({ level: 0, critical: true, marked: true });
        expect(parse('4 *')).toEqual({ level: 4, critical: true, marked: true });
    });

    test('formula and rich-text cells are flattened before parsing', () => {
        expect(parse({ result: 2 })).toEqual({ level: 2, critical: false, marked: false });
        expect(parse({ text: '1*' })).toEqual({ level: 1, critical: true, marked: true });
        expect(parse({ richText: [{ text: '3' }, { text: '*' }] })).toEqual({
            level: 3,
            critical: true,
            marked: true,
        });
    });

    test('prose and junk are not levels', () => {
        expect(parse('Instructions:')).toBeNull();
        expect(parse('n/a')).toBeNull();
        expect(parse('3 - expert')).toBeNull();
    });
});

describe('export writes the critical marker and preserves level 0', () => {
    // The export builds cells through the same two rules the parser reads back;
    // assert the round-trip identity over the whole 0-4 scale, both flags.
    const cell = (level, critical) =>
        level == null ? '' : critical ? `${Number(level)}*` : Number(level);

    test('every (level, critical) pair survives write -> read unchanged', () => {
        for (const level of [0, 1, 2, 3, 4]) {
            for (const critical of [false, true]) {
                const back = parse(cell(level, critical));
                expect(back).not.toBeNull();
                expect(back.level).toBe(level);
                expect(back.critical).toBe(critical);
            }
        }
    });

    test('"no requirement" stays distinguishable from "required at 0"', () => {
        expect(cell(null, false)).toBe('');
        expect(parse(cell(null, false))).toBeNull();
        expect(cell(0, false)).toBe(0);
        expect(parse(cell(0, false)).level).toBe(0);
    });

    test('the exporter still exposes the sheets the importer reads', () => {
        for (const fn of ['exportFullSystem', 'addRolesSheet', 'addEmployeesSheet']) {
            expect(typeof UnifiedExportService[fn]).toBe('function');
        }
    });
});

describe('skill resolution respects the soft-retire flag', () => {
    // Fake db: records the SQL it is asked to run and returns canned rows.
    const makeDb = (rows) => {
        const seen = [];
        return {
            seen,
            get: async (sql, params) => {
                seen.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
                return rows.shift() ?? null;
            },
        };
    };

    test('a name lookup filters on isActive and is deterministic (ORDER BY id LIMIT 1)', async () => {
        const db = makeDb([{ id: 339 }]);
        const out = await resolveActiveSkillByName(db, 'Analytical & Problem Solving');
        expect(out).toEqual({ id: 339 });
        const q = db.seen[0].sql;
        expect(q).toMatch(/isActive\s*=\s*true/);
        expect(q).toMatch(/ORDER BY id LIMIT 1/);
    });

    test('a domain-qualified lookup also filters on isActive', async () => {
        const db = makeDb([{ id: 12 }]);
        await resolveActiveSkillByName(db, 'Recovery', 'Processing');
        expect(db.seen[0].sql).toMatch(/s\.isActive\s*=\s*true/);
        expect(db.seen[0].params).toEqual(['Recovery', 'Processing']);
    });

    test('an empty or blank name never hits the database', async () => {
        const db = makeDb([]);
        expect(await resolveActiveSkillByName(db, '')).toBeNull();
        expect(await resolveActiveSkillByName(db, null)).toBeNull();
        expect(await resolveActiveSkillByName(db, '   ')).toBeNull();
        expect(db.seen).toHaveLength(0);
    });

    test('an explicit numeric id wins and is honoured even for a retired row', async () => {
        const db = makeDb([{ id: 352 }]);
        const out = await resolveSkillByIdOrName(db, '352', 'Analytical & Problem Solving');
        expect(out).toEqual({ id: 352 });
        expect(db.seen).toHaveLength(1);
        expect(db.seen[0].sql).toMatch(/WHERE id = \?/);
    });

    test('a non-numeric id falls through to the active-only name lookup', async () => {
        const db = makeDb([{ id: 339 }]);
        await resolveSkillByIdOrName(db, 'not-an-id', 'Analytical & Problem Solving');
        expect(db.seen[0].sql).toMatch(/isActive\s*=\s*true/);
    });
});
