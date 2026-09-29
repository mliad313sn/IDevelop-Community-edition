'use strict';
/**
 * Manual migration entry point: applies the base schema + every pending
 * db/postgres/NN_*.sql (idempotent, tracked in schema_meta). The same logic
 * runs automatically on server boot via db.migrate; this is for running it
 * standalone (CI, fresh installs). Usage: npm run db:migrate:all
 *
 * WHY IT DOES NOT STOP AT "Migrations complete". The runner swallows six
 * "object already exists" SQLSTATEs. Because each file runs inside ONE
 * transaction, such an error rolls back the WHOLE file and the key is still
 * written to schema_meta — with the value 'pre-existing' — so the file is never
 * retried. For a file of one statement that verdict is true. For a file of
 * several it is false: the statements after the failing one never ran, and the
 * database now carries a migration that says it is done. Measured on a
 * throwaway schema by replaying the runner's loop verbatim on a two-statement
 * file whose first statement raised 42701: outcome 'pre-existing', key stamped,
 * second statement (a uniqueness guard) absent, and the pre-flight reported
 * "nothing pending". That is the shape of the customer appliance failure of
 * 2026-09-09. So this entry point re-reads schema_meta after migrating and
 * refuses to print success over a half-applied file.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../src/config/database');
const { plan, ROLLED_BACK_VALUE } = require('./migrate-preflight');

const MIG_DIR = path.join(__dirname, '..', 'db', 'postgres');

(async () => {
    await db.connect();
    await db.migrate();

    let metaRows = [];
    try {
        metaRows = await db.all('SELECT key, value FROM schema_meta');
    } catch (_) {
        /* nothing to check */
    }
    const p = plan(fs.readdirSync(MIG_DIR), metaRows, (f) =>
        fs.readFileSync(path.join(MIG_DIR, f), 'utf8')
    );

    await db.close();

    // The check below only exists if schema_meta was read WITH its values and
    // the files could be read. Asked with the keys alone the plan answers 0 —
    // an absence of measurement wearing the face of a clean database. A
    // migration run is never blessed on a check that did not happen.
    if (!p.measured.values || !p.measured.contents) {
        console.error(
            '✗ Half-applied check NOT made: schema_meta values or the migration files were not read.'
        );
        console.error(
            '  Read schema_meta as (key, value) and pass a file reader to plan() — an unmeasured check is never a zero.'
        );
        process.exit(1);
    }
    if (p.halfApplied.length) {
        console.error(
            '✗ Migration recorded but NOT applied — the runner rolled these files back in full:'
        );
        for (const f of p.halfApplied)
            console.error(`    ! ${f} (schema_meta value '${ROLLED_BACK_VALUE}')`);
        console.error(
            '  A multi-statement file cannot be "already present": part of its content is missing.'
        );
        console.error(
            `  Fix the cause, delete the '${ROLLED_BACK_VALUE}' row from schema_meta and run this again.`
        );
        process.exit(1);
    }
    if (p.unverified.length) {
        // One statement, stamped 'pre-existing': plausible, but never silent.
        for (const f of p.unverified)
            console.log(
                `  • ${f} recorded as '${ROLLED_BACK_VALUE}' (single statement — object was already present)`
            );
    }
    console.log('✓ Migrations complete.');
})().catch((e) => {
    console.error('Migration failed:', e.message);
    process.exit(1);
});
