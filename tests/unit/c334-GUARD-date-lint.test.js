'use strict';
/**
 * Guard — no toISOString() on a DATE column, and the pg type contract.
 *
 * Why: node-pg hands a DATE column back as a JS Date at LOCAL midnight, so
 * `toISOString().slice(0, 10)` names the day before on a server east of UTC.
 * The HRIS nightly pass compared `last_scheduled_on` that way and could run
 * twice in one day. The right calls are src/utils/dateFormat.sqlDateIso (a
 * stored DATE) and appDayIso (today in the app's calendar), or
 * to_char(col, 'YYYY-MM-DD') in SQL.
 *
 * What: the DATE columns of the schema (information_schema of the test
 * database; skipped without one) are matched, snake and camel case, against every
 * `.<col>.toISOString()` and `new Date(x.<col>).toISOString()` in src/, views/
 * and public/js. Also pins the pg type contract: only the NUMERIC parser
 * (OID 1700) is installed, so a DATE parser cannot appear silently.
 *
 * Exceptions: allowlist.json → dateIso (file, col, reason).
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
jest.setTimeout(120000);

const { loadSchema, hasTestDb } = require('../helpers/guards/schema');
const S = require('../helpers/guards/scans');
const A = require('../helpers/guards/allowlist');
const R = require('../helpers/guards/repo');

const db = hasTestDb() ? require('../../src/config/database') : null;
let schema;
let sites;

const fmt = (s) =>
    `${s.file}:${s.line} .${s.col}.toISOString() → use dateFormat.sqlDateIso / appDayIso`;

// The DATE columns are read from the test database (see helpers/guards/schema.js).
const suite = db ? describe : describe.skip;

beforeAll(async () => {
    if (!db) return;
    await db.connect();
    schema = await loadSchema(db);
    sites = S.dateIsoSites(schema).filter(
        (s) => !A.allowed('dateIso', { file: s.file, col: s.col })
    );
});
afterAll(async () => {
    if (db) await db.close();
});

suite('no toISOString() on a DATE column', () => {
    test('the schema has DATE columns and the day helpers exist', () => {
        expect(schema.dateColumns().length).toBeGreaterThan(20);
        const df = require('../../src/utils/dateFormat');
        expect(typeof df.appDayIso).toBe('function');
        expect(typeof df.sqlDateIso).toBe('function');
        expect(A.unreasoned('dateIso')).toEqual([]);
    });

    test('no site', () => {
        expect(sites.map(fmt)).toEqual([]);
    });

    test('regression: the HRIS nightly pass reads last_scheduled_on through sqlDateIso', () => {
        const src = fs.readFileSync(
            path.join(R.REPO, 'src', 'services', 'HrisSyncService.js'),
            'utf8'
        );
        expect(src).toMatch(/sqlDateIso\(row\.lastScheduledOn\)/);
        expect(src).not.toMatch(/lastScheduledOn\)\.toISOString\(\)/);
    });

    test('mutation self-check: the scanner recognises both spellings of a DATE column', () => {
        const cols = new Set();
        for (const { col } of schema.dateColumns()) {
            cols.add(col);
            cols.add(R.snakeToCamel(col));
        }
        expect(cols.has('last_scheduled_on') && cols.has('lastScheduledOn')).toBe(true);
        expect(cols.has('expires_on') || cols.has('expiresOn')).toBe(true);
    });
});

describe('pg type contract (PostgresDatabase.js)', () => {
    const src = fs.readFileSync(
        path.join(R.REPO, 'src', 'database', 'PostgresDatabase.js'),
        'utf8'
    );
    test('only the NUMERIC parser (OID 1700) is installed; DATE (1082) and INT8 (20) stay as node-pg ships them', () => {
        const parsers = [...src.matchAll(/setTypeParser\(\s*(\d+)/g)].map((m) => Number(m[1]));
        expect(parsers).toEqual([1700]);
    });
});
