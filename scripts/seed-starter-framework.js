'use strict';
/* eslint-disable no-console */
/**
 * Load the generic STARTER capability framework into an empty (or partly
 * filled) database so a fresh installation is usable on day one:
 *
 *   6 pillars → 12 sub-domains → 34 skills (FR + EN descriptions),
 *   5 role families (with their skills) and 6 sample roles with requirements.
 *
 * Data: db/postgres/seed-data/starter-framework.json (CC0 — edit freely).
 * Proficiency level anchors are NOT duplicated here: the schema already ships
 * per-category descriptors (Behavioral, Technical, Safety, Compliance, …).
 *
 * Idempotent: every row is matched by name first and only created when absent,
 * so re-running never duplicates and never overwrites an edit made in the app.
 * Runs in ONE transaction. Dry run by default:
 *
 *   npm run db:seed:starter              # show what would be created (rolled back)
 *   npm run db:seed:starter -- --commit  # write it
 *
 * --file <path> loads another framework file of the same shape instead: a
 * sector pack from db/postgres/seed-data/packs/ (also loadable from the skills
 * library screen, /framework/library), or a file generated from ESCO by
 * scripts/import-esco.js. --lang fr stores the French names of a bilingual pack.
 *
 *   npm run db:seed:starter -- --file esco.json            # dry run
 *   npm run db:seed:starter -- --file esco.json --commit
 */
require('dotenv').config();
const path = require('path');
const db = require('../src/config/database');
// The loader lives in the service so the skills library screen
// (/framework/library) and this script import in exactly the same way.
const FrameworkPackService = require('../src/services/FrameworkPackService');

const DATA = FrameworkPackService.STARTER_FILE;
const { readFramework } = FrameworkPackService;

/** The framework file: --file <path> (or --file=<path>), else the bundled starter. */
function dataFile(argv) {
    const i = argv.indexOf('--file');
    if (i !== -1) {
        if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('--file needs a path');
        return path.resolve(argv[i + 1]);
    }
    const eq = argv.find((a) => a.startsWith('--file='));
    return eq ? path.resolve(eq.slice('--file='.length)) : DATA;
}

(async () => {
    const commit = process.argv.includes('--commit');
    const file = dataFile(process.argv.slice(2));
    const fw = readFramework(file);
    await db.connect();
    // --lang fr stores the French names of a bilingual pack (default English).
    const lang =
        process.argv.includes('--lang=fr') || process.argv.join(' ').includes('--lang fr')
            ? 'fr'
            : 'en';
    const report = commit
        ? await FrameworkPackService.commit(fw, { lang, source: file === DATA ? 'starter' : file })
        : await FrameworkPackService.dryRun(fw, { lang });
    const stats = report ? report.stats : null;
    console.log(`\n${fw.name} (v${fw.version})${file === DATA ? '' : ` from ${file}`}`);
    if (fw.attribution) console.log(`  ${fw.attribution}`);
    for (const [k, v] of Object.entries(stats || {}))
        console.log(`  ${k.padEnd(18)} ${v.created} new, ${v.existing} already there`);
    console.log(
        commit
            ? '\nCOMMITTED. Existing rows with the same names were left untouched.'
            : '\nDRY RUN - rolled back. Re-run with --commit to write.'
    );
    await db.close();
})().catch(async (e) => {
    console.error('Starter framework load failed:', e.message);
    try {
        await db.close();
    } catch (_) {
        /* already closed */
    }
    process.exit(1);
});
