'use strict';
/**
 * ZDB-8 — the runner never stamps a rolled-back multi-statement file as
 * 'pre-existing', and migrate() ends with the same post-flight the installer
 * runs, so a server boot refuses to serve over a half-applied migration.
 *
 * Measured by replaying the runner's catch block on a TEMP table with a
 * two-statement file (ADD COLUMN that exists; CREATE UNIQUE INDEX): verdict
 * "stamped pre-existing (42701)", index absent — the file was rolled back in
 * full and recorded as done. server.js called db.migrate() with no check.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const os = require('os');
const path = require('path');
const PostgresDatabase = require('../../src/database/PostgresDatabase');

const dup = (code) => Object.assign(new Error('already exists'), { code });

describe('_migrationVerdict', () => {
    const db = Object.create(PostgresDatabase.prototype);

    test('one statement + object-exists code → pre-existing (honest)', () => {
        expect(db._migrationVerdict(dup('42701'), 'ALTER TABLE t ADD COLUMN a int;')).toBe(
            'pre-existing'
        );
        expect(db._migrationVerdict(dup('42P07'), '-- comment\nCREATE TABLE t (a int);\n')).toBe(
            'pre-existing'
        );
    });

    test('several statements + object-exists code → rethrow (half-applied)', () => {
        expect(
            db._migrationVerdict(
                dup('42701'),
                'ALTER TABLE t ADD COLUMN a int;\nCREATE UNIQUE INDEX i ON t(a);'
            )
        ).toBe('rethrow');
    });

    test('a non-duplicate code is always rethrown, whatever the size', () => {
        expect(db._migrationVerdict(dup('23505'), 'CREATE UNIQUE INDEX i ON t(a);')).toBe(
            'rethrow'
        );
        expect(db._migrationVerdict(dup('42601'), 'SELECT 1;')).toBe('rethrow');
    });
});

describe('migrate() — the loop uses the verdict and ends with a post-flight', () => {
    let dir;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zdb8-'));
        fs.writeFileSync(path.join(dir, '01_schema.sql'), 'SELECT 1;');
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    /** A fake pool/client that raises `err` on the migration body and records schema_meta writes. */
    function fakeDb(err, metaRows) {
        const db = Object.create(PostgresDatabase.prototype);
        const client = {
            query: jest.fn(async (sql, params) => {
                if (/^BEGIN|^COMMIT|^ROLLBACK/.test(sql)) return { rows: [] };
                if (/INSERT INTO schema_meta/.test(sql)) {
                    metaRows.push({
                        key: params[0],
                        value: /pre-existing/.test(sql) ? 'pre-existing' : 'applied',
                    });
                    return { rows: [] };
                }
                if (/SELECT key, value FROM schema_meta/.test(sql)) return { rows: metaRows };
                if (/SELECT key FROM schema_meta/.test(sql)) return { rows: metaRows };
                if (err) throw err;
                return { rows: [] };
            }),
            release: jest.fn(),
        };
        db.pool = { connect: async () => client };
        db._client = () => client;
        db.get = async () => ({ value: '01-base' });
        return { db, client };
    }

    test('a two-statement file that hits 42701 is NOT stamped and migrate() fails loudly', async () => {
        const metaRows = [];
        const { db } = fakeDb(dup('42701'), metaRows);
        fs.writeFileSync(
            path.join(dir, '200_two.sql'),
            'ALTER TABLE t ADD COLUMN a int;\nCREATE UNIQUE INDEX i ON t(a);'
        );
        jest.spyOn(console, 'log').mockImplementation(() => {});
        await expect(db.migrate({ dir })).rejects.toThrow(/several statements|half|NOT recorded/i);
        expect(metaRows.find((r) => r.key === '200_two')).toBeUndefined();
    });

    test('a one-statement file that hits 42701 is stamped pre-existing and the post-flight passes', async () => {
        const metaRows = [];
        const { db } = fakeDb(dup('42701'), metaRows);
        fs.writeFileSync(path.join(dir, '200_one.sql'), 'ALTER TABLE t ADD COLUMN a int;');
        jest.spyOn(console, 'log').mockImplementation(() => {});
        await expect(db.migrate({ dir })).resolves.toBeUndefined();
        expect(metaRows).toEqual([{ key: '200_one', value: 'pre-existing' }]);
    });

    test('verifyMigrations refuses a shipped multi-statement file already recorded pre-existing', async () => {
        const metaRows = [{ key: '200_two', value: 'pre-existing' }];
        const { db } = fakeDb(null, metaRows);
        fs.writeFileSync(
            path.join(dir, '200_two.sql'),
            'ALTER TABLE t ADD COLUMN a int;\nCREATE UNIQUE INDEX i ON t(a);'
        );
        await expect(db.verifyMigrations(dir, fs.readdirSync(dir))).rejects.toThrow(
            /Refusing to start[\s\S]*200_two\.sql/
        );
    });

    test('verifyMigrations accepts a single-statement pre-existing stamp', async () => {
        const metaRows = [{ key: '200_one', value: 'pre-existing' }];
        const { db } = fakeDb(null, metaRows);
        fs.writeFileSync(path.join(dir, '200_one.sql'), 'ALTER TABLE t ADD COLUMN a int;');
        const p = await db.verifyMigrations(dir, fs.readdirSync(dir));
        expect(p.halfApplied).toEqual([]);
        expect(p.unverified).toEqual(['200_one.sql']);
    });
});
