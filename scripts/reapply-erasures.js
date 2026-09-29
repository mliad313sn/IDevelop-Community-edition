'use strict';
/**
 * Re-apply every GDPR erasure after a database restore (S-07).
 *
 * A pg_dump / pg_restore (Manage -Restore, SQL-console restore point) brings
 * back the database as it was — including people who asked to be erased
 * AFTER the dump was taken. Their erasure tombstones live in the
 * `erasure_tombstones` table AND in a mirror file beside the backups
 * (erasure-tombstones-<db>.jsonl), because the restore rolls the table back
 * too. This script merges the mirror into the table, then erases again every
 * subject whose row came back with `erased_at` empty — through the same
 * DSRService.erase path, one savepoint per subject.
 *
 * Usage:  node scripts/reapply-erasures.js [--file <mirror.jsonl>]
 * Exit:   0 = nothing left to re-apply, or all re-applied
 *         1 = at least one subject could NOT be erased again (listed on stderr)
 *         2 = the run itself failed (database unreachable, migration 151 absent)
 */
require('dotenv').config();
const db = require('../src/config/database');

function argFile(argv) {
    const i = argv.indexOf('--file');
    return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
}

(async () => {
    await db.connect();
    let code = 0;
    try {
        const DSR = require('../src/services/DSRService');
        const r = await DSR.reapplyTombstones({
            source: 'database restore (scripts/reapply-erasures.js)',
            file: argFile(process.argv.slice(2)),
        });
        console.log(
            `[reapply-erasures] ${r.tombstones} tombstone(s); ${r.mergedFromFile} restored from the mirror file; ` +
                `${r.reapplied.length} subject(s) erased again${r.reapplied.length ? ' [' + r.reapplied.join(', ') + ']' : ''}.`
        );
        if (r.failed.length) {
            code = 1;
            for (const f of r.failed) console.error(`  ! employee #${f.id}: ${f.error}`);
        }
    } catch (e) {
        code = 2;
        console.error('[reapply-erasures] FAILED:', e && e.message);
    } finally {
        await db.close().catch(() => {});
    }
    process.exit(code);
})();
