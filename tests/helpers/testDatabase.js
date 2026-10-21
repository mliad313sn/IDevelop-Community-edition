'use strict';
/**
 * The ONE guard every DB-backed suite uses to decide whether it may touch the
 * database named by DATABASE_URL.
 *
 * The guard reads the database NAME parsed from the URL, never a substring of
 * the whole string: a role called `ci_test`, a host called `idevelop_test.lan`
 * or a query parameter would otherwise let a suite plant and delete rows in a
 * production database.
 *
 *  - isTestDatabaseUrl(url): the name is `idevelop_test` or `idevelop_fixtures`,
 *    optionally followed by `_<suffix>` (per-developer or per-worker copies such
 *    as `idevelop_test_w01`), or any name ending in `_test`.
 *  - isFixturesDatabaseUrl(url): the populated fixtures database only
 *    (`idevelop_fixtures`, optionally `_<suffix>`). Suites that read the demo
 *    population use this one.
 */

const NAME_TEST = /^(?:idevelop_(?:test|fixtures)(?:_[A-Za-z0-9_]+)?|[A-Za-z0-9_]+_test)$/;
const NAME_FIXTURES = /^idevelop_fixtures(?:_[A-Za-z0-9_]+)?$/;

/** The database name of a postgres URL, or null when it cannot be parsed. */
function databaseName(url) {
    if (!url || typeof url !== 'string') return null;
    try {
        const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
        return name || null;
    } catch (_) {
        return null;
    }
}

function isTestDatabaseUrl(url = process.env.DATABASE_URL) {
    const name = databaseName(url);
    return !!name && NAME_TEST.test(name);
}

function isFixturesDatabaseUrl(url = process.env.DATABASE_URL) {
    const name = databaseName(url);
    return !!name && NAME_FIXTURES.test(name);
}

module.exports = { databaseName, isTestDatabaseUrl, isFixturesDatabaseUrl };
