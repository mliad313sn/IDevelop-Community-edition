'use strict';
/**
 * The DB-suite guard reads the database NAME, never a substring of the URL: a
 * role called `ci_test` or a host called `idevelop_test.lan` on a production
 * database must not let a suite plant or delete rows there.
 */
const fs = require('fs');
const path = require('path');
const {
    databaseName,
    isTestDatabaseUrl,
    isFixturesDatabaseUrl,
} = require('../helpers/testDatabase');

describe('isTestDatabaseUrl', () => {
    test.each([
        'postgres://u:p@localhost:5432/idevelop_test',
        'postgres://u:p@localhost:5432/idevelop_test_w01',
        'postgres://u:p@localhost:5432/idevelop_fixtures',
        'postgres://u:p@localhost:5432/idevelop_fixtures_local',
        'postgres://u:p@localhost:5432/lot_a_test',
        'postgresql://u:p@db.example.test/idevelop_test?sslmode=disable',
    ])('accepts %s', (url) => {
        expect(isTestDatabaseUrl(url)).toBe(true);
    });

    test.each([
        'postgres://ci_test:p@localhost:5432/idevelop',
        'postgres://u:p@idevelop_test.lan:5432/idevelop',
        'postgres://u:p@localhost:5432/idevelop?application_name=idevelop_test',
        'postgres://u:p@localhost:5432/idevelop_testing',
        'postgres://u:p@localhost:5432/test',
        'postgres://u:p@localhost:5432/',
        'not a url',
        '',
        null,
    ])('refuses %s', (url) => {
        expect(isTestDatabaseUrl(url)).toBe(false);
    });
});

describe('isFixturesDatabaseUrl', () => {
    test('only the fixtures database (and its suffixed copies)', () => {
        expect(isFixturesDatabaseUrl('postgres://u:p@h/idevelop_fixtures')).toBe(true);
        expect(isFixturesDatabaseUrl('postgres://u:p@h/idevelop_fixtures_2')).toBe(true);
        expect(isFixturesDatabaseUrl('postgres://u:p@h/idevelop_test')).toBe(false);
        expect(isFixturesDatabaseUrl('postgres://idevelop_fixtures:p@h/idevelop')).toBe(false);
    });
    test('databaseName decodes the path', () => {
        expect(databaseName('postgres://u:p@h:5432/idevelop_test')).toBe('idevelop_test');
        expect(databaseName('nope')).toBe(null);
    });
});

describe('no suite guards the database on a substring of the URL', () => {
    test('every DATABASE_URL regex guard was replaced by the name helper', () => {
        const dir = __dirname;
        const offenders = fs
            .readdirSync(dir)
            .filter((f) => f.endsWith('.js'))
            .filter((f) =>
                /\/[^/\n]*(idevelop_test|idevelop_fixtures|_test)[^/\n]*\/\w*\.test\(\s*(String\()?process\.env\.DATABASE_URL/.test(
                    fs.readFileSync(path.join(dir, f), 'utf8')
                )
            );
        expect(offenders).toEqual([]);
    });
});
