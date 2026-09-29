'use strict';
/**
 * Guard for the one-shot DATA-MUTATING scripts under scripts/ (framework
 * loaders, backfills, purges). Three rules, the same for every one of them:
 *
 *   1. NODE_ENV=production is refused outright. These scripts are development
 *      tooling; Build-Package keeps them out of the shipped payload, and this
 *      is the belt to that braces should one ever reach an appliance.
 *   2. Dry-run by DEFAULT. A script only writes when `--commit` is passed; the
 *      caller runs its writes inside db.runTransaction and throws ROLLBACK
 *      when `commit` is false, so a dry run shows exactly what a real run would
 *      do and leaves nothing behind.
 *   3. The verdict says which of the two happened - never "Done" on a rollback.
 *
 * Measured before this guard (2026-09-17): `node scripts/assign-role-families.js`
 * carried no dry-run, no --commit and no environment check, and updated
 * roles.role_family_id in an unconditional loop.
 */

const ROLLBACK = '__ROLLBACK__';

function isProduction(env = process.env) {
    return String(env.NODE_ENV || '').toLowerCase() === 'production';
}

/**
 * @param {string[]} argv       process.argv.slice(2)
 * @param {object}   [env]      process.env (injectable for tests)
 * @returns {{commit:boolean, dryRun:boolean}}
 * @throws {Error} when NODE_ENV=production
 */
function oneShotGuard(argv = process.argv.slice(2), env = process.env) {
    if (isProduction(env)) {
        throw new Error(
            'REFUSED: NODE_ENV=production. This one-shot script is development tooling and never runs on a production instance.'
        );
    }
    const commit = argv.includes('--commit');
    return { commit, dryRun: !commit };
}

/**
 * Run `work` inside db.runTransaction; roll it back unless `commit` is true.
 * Returns whatever `work` returned. Any error other than the rollback sentinel
 * is rethrown.
 */
async function runGuarded(db, commit, work) {
    let result;
    try {
        await db.runTransaction(async () => {
            result = await work();
            if (!commit) throw new Error(ROLLBACK);
        });
    } catch (e) {
        if (!(e && e.message === ROLLBACK)) throw e;
    }
    return result;
}

function verdict(commit, what) {
    return commit
        ? `COMMITTED: ${what}.`
        : `DRY RUN - rolled back: ${what}. Nothing was changed. Re-run with --commit to apply.`;
}

module.exports = { oneShotGuard, runGuarded, verdict, isProduction, ROLLBACK };
