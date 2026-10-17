'use strict';
/**
 * Guard — columns written but never read, and columns never referenced at all.
 *
 * Why: a column that src/ writes (INSERT list / UPDATE SET) but that nothing
 * reads (src, views, public) is a record nobody consults. Most are deliberate
 * audit stamps (who cancelled, who released); each is pinned in
 * tests/helpers/guards/dead-columns.snapshot.json with its reason. The list
 * may only SHRINK: a new write-only column fails here until it is reviewed and
 * pinned.
 *
 * What: every column of the schema (test database; skipped without one), short or generic names aside, is counted in src/ (reads minus writes)
 * and in views/ and public/js, and compared with the snapshot. A pinned column
 * that is read again is reported on stderr (prune the snapshot), not failed.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
jest.setTimeout(240000);

const { loadSchema, hasTestDb } = require('../helpers/guards/schema');
const S = require('../helpers/guards/scans');

const SNAP_FILE = path.join(__dirname, '..', 'helpers', 'guards', 'dead-columns.snapshot.json');
const SNAP = JSON.parse(fs.readFileSync(SNAP_FILE, 'utf8'));
const db = hasTestDb() ? require('../../src/config/database') : null;
let dead;

// The columns are read from the test database (see helpers/guards/schema.js).
const suite = db ? describe : describe.skip;

beforeAll(async () => {
    if (!db) return;
    await db.connect();
    dead = S.deadColumns(await loadSchema(db));
});
afterAll(async () => {
    if (db) await db.close();
});

const key = (c) => `${c.table}.${c.col}`;
const pinned = (kind) => new Set(SNAP.columns.filter((c) => c.kind === kind).map(key));

suite('write-only and never-referenced columns are pinned with a reason', () => {
    test('snapshot entries all carry a reason and a kind', () => {
        expect(
            SNAP.columns
                .filter(
                    (c) =>
                        !c.reason ||
                        c.reason.length < 8 ||
                        !['deadWritten', 'neverReferenced'].includes(c.kind)
                )
                .map(key)
        ).toEqual([]);
    });
    test('no NEW column written by src/ and read nowhere', () => {
        const pin = pinned('deadWritten');
        expect(
            dead.deadWritten
                .filter((c) => !pin.has(key(c)))
                .map((c) => `${key(c)} written at ${c.writes.join(' ')}`)
        ).toEqual([]);
    });
    test('no NEW column never referenced by src/, views/ or public/', () => {
        const pin = pinned('neverReferenced');
        expect(dead.neverReferenced.filter((c) => !pin.has(key(c))).map(key)).toEqual([]);
    });
    test('report: pinned columns that are read again (prune the snapshot)', () => {
        const now = new Set([...dead.deadWritten, ...dead.neverReferenced].map(key));
        const stale = SNAP.columns.map(key).filter((k) => !now.has(k));
        if (stale.length)
            process.stderr.write(
                `[dead-columns] stale snapshot pins (now read, or column gone): ${stale.join(', ')}\n`
            );
        expect(stale.length).toBeLessThanOrEqual(SNAP.columns.length);
    });
});
