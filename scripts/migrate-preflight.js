'use strict';
/**
 * Migration pre-flight / post-flight report — what `Install-IDevelop.ps1 -Migrate`
 * runs BEFORE touching the database and AGAIN after `db:migrate:all`.
 *
 *   node scripts/migrate-preflight.js            → report, exit 0
 *   node scripts/migrate-preflight.js --expect-none → exit 3 if anything is still pending
 *
 * Exit codes: 0 ok · 2 DOWNGRADE (database is ahead of this package) · 3 pending
 * migrations remain after a migration run · 1 error.
 *
 * WHY THIS IS THE COMPATIBILITY CONTRACT
 *   Every schema change is a numbered file db/postgres/NN_*.sql, applied in
 *   numeric order and recorded in schema_meta(key = file name). Migrating an
 *   older install to ANY newer package therefore means: apply the files this
 *   package ships that schema_meta does not list yet — nothing else. The runner
 *   is idempotent (a second pass applies 0), so re-running is always safe.
 *   The one thing that can never be safe is the other direction: a database
 *   whose schema_meta lists a migration number HIGHER than anything this
 *   package ships was produced by a NEWER version, and this code would run
 *   against columns/views it does not know. That is refused here (exit 2)
 *   before a single statement runs — the installer's auto-rollback would not
 *   help, because nothing would have failed yet; the damage would surface later,
 *   as a wrong number on a screen.
 *
 * THE RULE THIS FILE MUST NEVER BREAK: "pending" means EXACTLY what the runner
 *   (PostgresDatabase.migrate) means — same file selection, same key, and the
 *   key looked up against EVERY schema_meta row. The first version filtered the
 *   applied keys to /^\d+_/ and so did not see `01a_enum_prereqs` — a prerequisite
 *   script an operator had applied by hand at 3.22.1 and recorded in schema_meta,
 *   whose .sql still sat in the install directory (the installer overlays code,
 *   it never deletes stale files). The runner honoured the key and skipped the
 *   file; this report called it pending; the post-flight failed; the installer
 *   rolled the CODE back over a database that had just been migrated — an old
 *   version running on a newer schema, the exact thing this report exists to
 *   prevent (customer appliance, 3.22.85 -> 3.22.91, 2026-09-09).
 *
 * THE SECOND RULE: a migration recorded as done must MEAN its content is in the
 *   database. It does not always. The runner (PostgresDatabase.migrate) runs each
 *   file inside ONE transaction and classes six SQLSTATEs as "the object is
 *   already there" (42P07, 42710, 42P06, 42701, 42723, 42P16). When one of them
 *   fires, the whole FILE is rolled back and the key is still written — with the
 *   value 'pre-existing' — so the file is never retried. Measured on a throwaway
 *   schema, the runner's loop replayed verbatim on a two-statement file whose
 *   FIRST statement raised 42701: outcome 'pre-existing', schema_meta stamped,
 *   and the second statement (a uniqueness guard) never ran. This report counted
 *   0 pending and printed "POST-FLIGHT OK: schema matches the package".
 *   "Object already exists" is only a truthful verdict for a file of ONE
 *   statement. So: every shipped file stamped 'pre-existing' is reported here,
 *   and one that carries MORE THAN ONE statement is a HALF-APPLIED migration —
 *   post-flight refuses it (exit 3) instead of blessing the upgrade. The rule is
 *   deliberately narrow: only the runner's own 'pre-existing' marker counts, never
 *   "any value that is not 'applied'" — schema_meta legitimately carries other
 *   values (schema_version, source, a hand-applied prerequisite's stamp), and
 *   failing on those would rebuild the very 2026-09-09 regression above.
 */
const fs = require('fs');
const path = require('path');

const MIG_DIR = path.join(__dirname, '..', 'db', 'postgres');

/** The value PostgresDatabase.migrate writes when it rolled a file back but stamped it anyway. */
const ROLLED_BACK_VALUE = 'pre-existing';

/**
 * The runner's own selection, verbatim (PostgresDatabase.migrate): numbered .sql
 * files, never the *_down.sql rollback scripts, never the base schema
 * 01_schema.sql (tracked separately as the schema tag). tests/unit/migratePreflight
 * pins this string against the runner's source so the two cannot drift apart.
 */
const isMigrationFile = (f) =>
    /^\d+.*\.sql$/.test(f) && !/_down\.sql$/i.test(f) && f !== '01_schema.sql';
/** The key the runner records in schema_meta: the file name WITHOUT .sql. */
const keyOf = (f) => f.replace(/\.sql$/i, '');
/** Leading number of a file / key — `01a_enum_prereqs` is 1, `106_kpi…` is 106. */
const num = (name) => {
    const m = /^(\d+)/.exec(name);
    return m ? Number(m[1]) : null;
};
const byNumber = (a, b) => (num(a) || 0) - (num(b) || 0) || a.localeCompare(b);

/**
 * How many SQL statements a migration file actually carries.
 *
 * This is the whole difference between "the object was already there" (true for
 * a file of ONE statement) and "the runner threw the file away and stamped it"
 * (what happens to every later statement of a multi-statement file). Comments,
 * quoted literals, quoted identifiers and dollar-quoted bodies — a `DO $$ …
 * IF NOT EXISTS … ; … $$` block is ONE statement no matter how many semicolons
 * it contains — never count.
 * @param {string} sql raw file contents
 * @returns {number} number of non-empty top-level statements
 */
function statementCount(sql) {
    const s = String(sql || '');
    let count = 0;
    let hasContent = false; // something other than whitespace since the last ';'
    let i = 0;
    while (i < s.length) {
        const c = s[i];
        if (c === '-' && s[i + 1] === '-') {
            // -- line comment
            const nl = s.indexOf('\n', i);
            i = nl === -1 ? s.length : nl + 1;
            continue;
        }
        if (c === '/' && s[i + 1] === '*') {
            // /* nestable block comment */
            let depth = 1;
            i += 2;
            while (i < s.length && depth > 0) {
                if (s[i] === '/' && s[i + 1] === '*') {
                    depth++;
                    i += 2;
                } else if (s[i] === '*' && s[i + 1] === '/') {
                    depth--;
                    i += 2;
                } else i++;
            }
            continue;
        }
        if (c === "'" || c === '"') {
            // literal / quoted identifier
            const q = c;
            i++;
            while (i < s.length) {
                if (s[i] === q) {
                    if (s[i + 1] === q) i += 2;
                    else {
                        i++;
                        break;
                    }
                } else i++;
            }
            hasContent = true;
            continue;
        }
        if (c === '$') {
            // $$ … $$ / $tag$ … $tag$
            const m = /^\$[A-Za-z_-￿][A-Za-z0-9_-￿]*\$|^\$\$/.exec(s.slice(i));
            if (m) {
                const tag = m[0];
                const end = s.indexOf(tag, i + tag.length);
                i = end === -1 ? s.length : end + tag.length;
                hasContent = true;
                continue;
            }
        }
        if (c === ';') {
            if (hasContent) count++;
            hasContent = false;
            i++;
            continue;
        }
        if (!/\s/.test(c)) hasContent = true;
        i++;
    }
    if (hasContent) count++; // last statement, no trailing ';'
    return count;
}

/**
 * schema_meta rows may arrive as plain keys (older callers) or as {key, value}.
 *
 * The second return value says whether the VALUES were actually supplied. A
 * caller that ran `SELECT key FROM schema_meta` hands us nothing to compare
 * against 'pre-existing', so its plan can only ever answer "0 recorded
 * unapplied" — a zero that means "not measured". Measured on a development
 * database on 2026-09-16: with a shipped two-statement file stamped
 * 'pre-existing', plan(files, {key,value}, reader) reports unverified=1
 * halfApplied=1 while plan(files, keys) reports 0 and 0. Both zeros are
 * indistinguishable from a healthy database unless the plan says which
 * question it was given the means to answer — so it now says.
 */
const metaRowsToMap = (meta) => {
    const m = new Map();
    let valuesKnown = true;
    for (const r of meta || []) {
        if (r && typeof r === 'object') {
            if (!Object.prototype.hasOwnProperty.call(r, 'value')) valuesKnown = false;
            m.set(r.key, r.value == null ? null : String(r.value));
        } else {
            m.set(String(r), null);
            valuesKnown = false;
        }
    }
    return { values: m, valuesKnown };
};

/**
 * Pure plan: what is shipped, what is applied, what is pending, what is ahead,
 * and which shipped files the runner stamped without applying.
 * @param {string[]} files  directory listing of db/postgres
 * @param {Array<string|{key:string,value:*}>} meta EVERY schema_meta row (not just the numbered ones)
 * @param {(file:string)=>string} [readSql] reads a migration file — supply it to
 *        separate a benign one-statement 'pre-existing' from a HALF-APPLIED file.
 * @returns {{shipped:string[],applied:string[],pending:string[],ahead:string[],
 *   shippedMax:number,unverified:string[],halfApplied:string[],
 *   measured:{values:boolean,contents:boolean}}}
 *   `measured` says which questions the caller gave this plan the means to
 *   answer: `values` — the schema_meta values were supplied, so `unverified` is
 *   a measurement; `contents` — the files could be read, so `halfApplied` is a
 *   measurement (it needs BOTH). When a flag is false the matching list is an
 *   empty array only because nothing was measured, and a caller must report it
 *   as unmeasured, never as zero.
 */
function plan(files, meta, readSql) {
    const shipped = files.filter(isMigrationFile).sort(byNumber);
    const { values, valuesKnown } = metaRowsToMap(meta);
    const allKeys = new Set(values.keys());
    // Numbered keys — shipped files AND hand-applied prerequisites (01a_…) alike.
    const applied = [...allKeys].filter((k) => /^\d/.test(k) && k !== '01_schema').sort(byNumber);
    // Pending = the runner's own test: file shipped, key absent from schema_meta.
    const pending = shipped.filter((f) => !allKeys.has(keyOf(f)));
    const shippedMax = shipped.length ? num(shipped[shipped.length - 1]) : 0;
    const ahead = applied.filter((k) => num(k) != null && num(k) > shippedMax);
    // Stamped by the runner AFTER rolling the file back: its content may be absent.
    const unverified = shipped.filter((f) => values.get(keyOf(f)) === ROLLED_BACK_VALUE);
    // Of those, the ones that provably cannot be "the object was already there".
    const halfApplied =
        typeof readSql === 'function'
            ? unverified.filter((f) => {
                  try {
                      return statementCount(readSql(f)) > 1;
                  } catch (_) {
                      return true;
                  }
              })
            : [];
    return {
        shipped,
        applied,
        pending,
        ahead,
        shippedMax,
        unverified,
        halfApplied,
        measured: { values: valuesKnown, contents: typeof readSql === 'function' },
    };
}

async function main() {
    // Same convention as scripts/migrate.js: the installer passes DATABASE_URL in
    // the child environment; a manual run picks it up from .env.
    try {
        require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
    } catch (_) {
        /* optional */
    }
    const expectNone = process.argv.includes('--expect-none');
    const db = require('../src/config/database');
    await db.connect();

    let metaRows = [];
    try {
        metaRows = await db.all('SELECT key, value FROM schema_meta');
    } catch (_) {
        /* first install — no schema_meta yet: everything is pending */
    }
    const p = plan(fs.readdirSync(MIG_DIR), metaRows, (f) =>
        fs.readFileSync(path.join(MIG_DIR, f), 'utf8')
    );
    // The half-applied check exists only if schema_meta was read WITH its values
    // and the files could be read. Asked any other way the plan answers 0 — a
    // zero that means "not measured", which is precisely what printed
    // "POST-FLIGHT OK" over the 2026-09-09 appliance. Refuse instead.
    if (!p.measured.values || !p.measured.contents) {
        console.log(
            '  PRE-FLIGHT ERROR: schema_meta values or the migration files were not read —' +
                ' the "recorded but rolled back" check could NOT be made. This report never reports an' +
                ' unmeasured check as zero.'
        );
        await db.close().catch(() => {});
        process.exit(1);
    }
    let installedVersion = null;
    try {
        installedVersion =
            ((await db.get("SELECT value FROM schema_meta WHERE key = 'schema_version'")) || {})
                .value || null;
    } catch (_) {
        /* n/a */
    }
    const pkgVersion = require('../package.json').version;

    console.log('MIGRATION PRE-FLIGHT');
    console.log(`  package version       : ${pkgVersion}`);
    console.log(`  database schema tag   : ${installedVersion || '(none)'}`);
    console.log(`  migrations in package : ${p.shipped.length} (highest ${p.shippedMax})`);
    console.log(`  applied in database   : ${p.applied.length}`);
    console.log(`  pending to apply      : ${p.pending.length}`);
    for (const f of p.pending) console.log(`    + ${f}`);
    // A stamp the runner wrote AFTER rolling the file back. Never silent: a
    // migration recorded as done whose content is not in the database is the
    // shape of the 2026-09-09 appliance failure.
    console.log(`  recorded unapplied    : ${p.unverified.length}`);
    for (const f of p.unverified) {
        const n = statementCount(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
        console.log(
            `    ? ${f} — schema_meta value '${ROLLED_BACK_VALUE}', ${n} statement(s)` +
                (n > 1
                    ? ' — HALF-APPLIED: the file was rolled back in full'
                    : ' — single statement, plausibly already present')
        );
    }

    if (p.ahead.length) {
        console.log(
            '  DOWNGRADE REFUSED: the database already carries migration(s) this package does not ship:'
        );
        for (const k of p.ahead) console.log(`    ! ${k}`);
        console.log(
            '  This database was produced by a NEWER version. Use a package of that version or newer.'
        );
        await db.close().catch(() => {});
        process.exit(2);
    }
    if (expectNone && p.pending.length) {
        console.log('  POST-FLIGHT FAILED: migrations still pending after the migration run.');
        await db.close().catch(() => {});
        process.exit(3);
    }
    if (expectNone && p.halfApplied.length) {
        console.log(
            '  POST-FLIGHT FAILED: migration(s) recorded as done that the runner rolled back in full:'
        );
        for (const f of p.halfApplied) console.log(`    ! ${f}`);
        console.log(
            '  A multi-statement file cannot be "already present": part of its content is NOT in the database.'
        );
        console.log(
            `  Fix the cause, delete the '${ROLLED_BACK_VALUE}' row from schema_meta and migrate again.`
        );
        await db.close().catch(() => {});
        process.exit(3);
    }
    console.log(
        expectNone
            ? '  POST-FLIGHT OK: nothing pending — schema matches the package.'
            : '  PRE-FLIGHT OK.'
    );
    await db.close().catch(() => {});
    process.exit(0);
}

module.exports = { plan, isMigrationFile, keyOf, num, statementCount, ROLLED_BACK_VALUE };

if (require.main === module) {
    main().catch((e) => {
        console.error('PRE-FLIGHT ERROR:', e.message);
        process.exit(1);
    });
}
