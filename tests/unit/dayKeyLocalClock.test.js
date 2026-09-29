'use strict';

/**
 * Re-audit J12 — job ticks gated on LOCAL time (getHours/getDay/getDate) but
 * keyed "already ran today" off toISOString() (UTC). Near local midnight off-UTC
 * the gate and the key split, so a tick could run twice or skip a day. The day
 * key now comes from the same local clock the gate uses (utils/dayKey).
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

const { dayKey } = require('../../src/utils/dayKey');

describe('dayKey is the LOCAL calendar day', () => {
    test('formats YYYY-MM-DD from the local components of a Date', () => {
        const d = new Date(2026, 0, 5, 23, 30); // 5 Jan 2026, local
        expect(dayKey(d)).toBe('2026-01-05');
    });

    test('pads month and day', () => {
        expect(dayKey(new Date(2026, 8, 9, 1, 0))).toBe('2026-09-09');
    });

    test('uses local, not UTC, components', () => {
        // A fixed instant; local vs UTC can differ off-UTC. We assert dayKey tracks
        // the LOCAL getDate(), whatever this host's zone is.
        const d = new Date();
        const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        expect(dayKey(d)).toBe(expected);
    });

    test('defaults to now', () => {
        expect(dayKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
});

describe('the mixed-clock jobs key off the local day, not toISOString', () => {
    test.each([
        'src/jobs/retention-recompute.js',
        'src/jobs/dept-digest.js',
        'src/jobs/manager-digest.js',
    ])('%s imports dayKey and uses it for `today`', (p) => {
        const src = read(p);
        expect(src).toMatch(/require\('\.\.\/utils\/dayKey'\)/);
        expect(src).toMatch(/const today = dayKey\(now\)/);
        // and no longer derives the day key from UTC
        expect(src).not.toMatch(/const today = now\.toISOString\(\)\.slice\(0, 10\)/);
    });
});
