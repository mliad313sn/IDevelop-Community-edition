'use strict';
/**
 * Guard tests — schema loader for the guard suites.
 *
 *   loadSchema(db)  → { source:'db', tables:{ name:{ columns:{c:{type,udt}}, checks:[{name,cols,values}] } },
 *                      enums:{ typname:[values] }, views:[names], valueSets(), dateColumns(),
 *                      liveValues(table, col) }
 *
 * The source of truth is the test database (information_schema, pg_constraint,
 * pg_enum; read-only). There is no fallback on db/postgres/*.sql: a parser of
 * the migration files misses `ALTER TYPE … ADD VALUE`, constraints added in DO
 * blocks and columns dropped later, and a guard that reads a wrong schema
 * proves nothing. Without a test database the schema suites are skipped.
 */
const { isTestDatabaseUrl } = require('../testDatabase');

const IDENT = /^[a-z_][a-z0-9_]*$/;

function finish(out) {
    /** table → col → Set(allowed values) for every enum-typed column and single-column CHECK IN-list. */
    out.valueSets = () => {
        const sets = {};
        for (const [tn, t] of Object.entries(out.tables)) {
            for (const [cn, c] of Object.entries(t.columns)) {
                let vals = null;
                if (out.enums[c.udt]) vals = new Set(out.enums[c.udt]);
                for (const k of t.checks)
                    if (k.values.length && k.cols.length === 1 && k.cols[0] === cn)
                        vals = new Set([...(vals || []), ...k.values]);
                if (vals) (sets[tn] = sets[tn] || {})[cn] = vals;
            }
        }
        return sets;
    };
    /** DATE (not timestamp) columns: [{table, col}] */
    out.dateColumns = () => {
        const cols = [];
        for (const [tn, t] of Object.entries(out.tables))
            for (const [cn, c] of Object.entries(t.columns))
                if (c.type === 'date') cols.push({ table: tn, col: cn });
        return cols;
    };
    return out;
}

async function fromDb(db) {
    const out = { source: 'db', tables: {}, enums: {}, views: [] };
    const cols = await db.all(
        `SELECT table_name AS "tableName", column_name AS "columnName", data_type AS "dataType", udt_name AS "udtName"
           FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`
    );
    const tabs = await db.all(
        `SELECT table_name AS "tableName", table_type AS "tableType" FROM information_schema.tables WHERE table_schema = 'public'`
    );
    for (const t of tabs) {
        if (t.tableType === 'VIEW') out.views.push(t.tableName);
        else out.tables[t.tableName] = { columns: {}, checks: [] };
    }
    for (const r of cols) {
        const t = out.tables[r.tableName];
        if (!t) continue;
        t.columns[r.columnName] = { type: r.dataType, udt: r.udtName };
    }
    const cons = await db.all(
        `SELECT conrelid::regclass::text AS "tbl", conname AS "conname", pg_get_constraintdef(oid) AS "def",
                (SELECT array_agg(attname::text ORDER BY ord) FROM unnest(conkey) WITH ORDINALITY AS k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = conrelid AND a.attnum = k.attnum) AS "cols"
           FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype = 'c'`
    );
    for (const r of cons) {
        const t = out.tables[r.tbl];
        if (!t) continue;
        t.checks.push({ name: r.conname, cols: r.cols || [], values: valuesOf(r.def) });
    }
    const enums = await db.all(
        `SELECT t.typname AS "typname", array_agg(e.enumlabel::text ORDER BY e.enumsortorder)::text[] AS "vals"
           FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
          WHERE t.typnamespace = 'public'::regnamespace GROUP BY t.typname`
    );
    for (const r of enums) out.enums[r.typname] = r.vals;
    /**
     * Live distinct values of one column (counts only, no person data). The
     * table and column come from information_schema and are re-checked here:
     * only a known table and a known column of it are ever interpolated.
     */
    out.liveValues = async (table, col) => {
        const t = out.tables[table];
        if (!t || !t.columns[col] || !IDENT.test(table) || !IDENT.test(col)) return [];
        const rows = await db.all(
            `SELECT "${col}"::text AS "v", COUNT(*)::int AS "n" FROM "${table}" GROUP BY 1 ORDER BY 2 DESC LIMIT 60`
        );
        return rows.map((r) => [r.v, r.n]);
    };
    return finish(out);
}

/** the IN ('a','b') / = ANY(ARRAY['a','b']) literal list of a CHECK definition */
function valuesOf(def) {
    const vals = [];
    const m = def.match(/ANY \(\(?ARRAY\[([^\]]*)\]/) || def.match(/IN \(([^)]*)\)/);
    if (m) for (const v of m[1].matchAll(/'((?:[^']|'')*)'/g)) vals.push(v[1].replace(/''/g, "'"));
    return vals;
}

let cached = null;
/** `db` = the app's src/config/database module, connected to a test database. */
async function loadSchema(db) {
    if (cached) return cached;
    if (!db) throw new Error('the guard suites read the schema from a test database');
    cached = await fromDb(db);
    return cached;
}

/**
 * true when DATABASE_URL names a test database: the database NAME is checked
 * by the one shared helper (tests/helpers/testDatabase.js), never a substring
 * of the URL.
 */
function hasTestDb() {
    return isTestDatabaseUrl(process.env.DATABASE_URL);
}

module.exports = { loadSchema, hasTestDb, valuesOf };
