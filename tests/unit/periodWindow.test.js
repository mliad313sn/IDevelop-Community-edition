'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * PERIOD WINDOWS — the arithmetic the department brief is dated by.
 *
 * Two defects this file exists to prevent, both live in the current jobs:
 *
 *  1. TWO CLOCKS. manager-digest.js:38 and planning-digest.js:205 gate on the
 *     LOCAL day/hour while weekBucket/monthBucket bucket in UTC. On a period
 *     boundary the gate opens for a period the bucket does not name: the brief
 *     is mislabelled, or its bucket is already claimed and the brief is SKIPPED
 *     — for the yearly cadence, skipped for a year.
 *
 *  2. "THE SAME NUMBER OF DAYS BACK". A month is 28 to 31 days, a quarter 90 to
 *     92, a year 365 or 366. Comparing February with the previous 28 days
 *     manufactures a −10 % every single year. The previous window here is the
 *     previous CALENDAR period, and both windows publish their own length.
 *
 * Every bound is midnight UTC, the upper bound is EXCLUSIVE, and the period is
 * always one that has already CLOSED.
 */

const {
    windowFor,
    bucketFor,
    daysSinceClose,
    CADENCES,
    HORIZON_DAYS,
    CATCH_UP_DAYS,
} = require('../../src/utils/periodWindow');
const reminders = require('../../src/jobs/reminders');
const { fmtPeriodBound } = require('../../src/utils/dateFormat');

const iso = (d) => d.toISOString();
const at = (s) => new Date(s);

describe('the bucket registry is shared, never forked', () => {
    test('reminders.js exports all four buckets', () => {
        expect(typeof reminders.weekBucket).toBe('function');
        expect(typeof reminders.monthBucket).toBe('function');
        expect(typeof reminders.quarterBucket).toBe('function');
        expect(typeof reminders.yearBucket).toBe('function');
    });

    test('periodWindow uses THOSE functions and defines none of its own', () => {
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '../../src/utils/periodWindow.js'),
            'utf8'
        );
        expect(src).toMatch(/require\('\.\.\/jobs\/reminders'\)/);
        // cycle-nudge.js already forked a different week bucket; this must not.
        expect(src).not.toMatch(/function\s+weekBucket/);
        expect(src).not.toMatch(/function\s+quarterBucket/);
        expect(src).not.toMatch(/function\s+yearBucket/);
    });

    test('the quarter and year buckets are UTC', () => {
        const d = at('2026-01-01T00:30:00Z'); // 31/12/2025 in any western zone
        expect(reminders.quarterBucket(d)).toBe('2026-Q1');
        expect(reminders.yearBucket(d)).toBe('2026');
    });

    test('bucketFor routes each cadence to its own bucket', () => {
        const d = at('2026-07-01T00:00:00Z');
        expect(bucketFor('monthly', d)).toBe('2026-07');
        expect(bucketFor('quarterly', d)).toBe('2026-Q3');
        expect(bucketFor('yearly', d)).toBe('2026');
        expect(bucketFor('weekly', d)).toMatch(/^2026-W\d\d$/);
    });
});

describe('weekly — the ISO week, including the one that straddles two years', () => {
    test('a brief anchored mid-week reports the week that CLOSED', () => {
        const w = windowFor('weekly', at('2026-09-13T07:00:00Z')); // a Sunday
        expect(iso(w.periodStart)).toBe('2026-08-31T00:00:00.000Z');
        expect(iso(w.periodEnd)).toBe('2026-09-07T00:00:00.000Z');
        expect(w.days).toBe(7);
        expect(w.bucket).toBe('2026-W36');
    });

    test('the week of 28/12/2020 belongs to 2020-W53, not to 2021', () => {
        const w = windowFor('weekly', at('2021-01-05T09:00:00Z'));
        expect(iso(w.periodStart)).toBe('2020-12-28T00:00:00.000Z');
        expect(iso(w.periodEnd)).toBe('2021-01-04T00:00:00.000Z');
        // The label carries a YEAR different from the one the upper bound sits in.
        expect(w.bucket).toBe('2020-W53');
        expect(w.prevBucket).toBe('2020-W52');
    });

    test('an anchor that IS Monday 00:00 UTC still reports the closed week', () => {
        const w = windowFor('weekly', at('2026-09-07T00:00:00Z'));
        expect(iso(w.periodEnd)).toBe('2026-09-07T00:00:00.000Z');
        expect(iso(w.periodStart)).toBe('2026-08-31T00:00:00.000Z');
    });

    test('a week spanning a daylight-saving change is still exactly 7 days', () => {
        // Europe/Paris moved to summer time on 29/03/2026; the UTC window cannot
        // notice, and that is the point.
        const w = windowFor('weekly', at('2026-03-30T12:00:00Z'));
        expect(w.days).toBe(7);
        expect(w.prevDays).toBe(7);
        expect(w.periodEnd - w.periodStart).toBe(7 * 86400000);
    });
});

describe('monthly — 29 February is 29 days, and January is not February', () => {
    test('February 2024 is 29 days and its previous month is 31', () => {
        const w = windowFor('monthly', at('2024-03-10T00:00:00Z'));
        expect(iso(w.periodStart)).toBe('2024-02-01T00:00:00.000Z');
        expect(iso(w.periodEnd)).toBe('2024-03-01T00:00:00.000Z');
        expect(w.days).toBe(29);
        expect(w.prevDays).toBe(31);
        expect(w.bucket).toBe('2024-02');
        // The inclusive bound printed to a reader is 29/02/2024, never 01/03.
        expect(fmtPeriodBound(w.displayEnd)).toBe('29/02/2024');
    });

    test('a January anchor rolls back across the year boundary', () => {
        const w = windowFor('monthly', at('2026-01-15T00:00:00Z'));
        expect(iso(w.periodStart)).toBe('2025-12-01T00:00:00.000Z');
        expect(iso(w.prevStart)).toBe('2025-11-01T00:00:00.000Z');
        expect(w.bucket).toBe('2025-12');
        expect(w.prevBucket).toBe('2025-11');
    });

    test('the two windows are adjacent: prevEnd === periodStart', () => {
        for (const c of CADENCES) {
            const w = windowFor(c, at('2026-05-17T11:00:00Z'));
            expect(+w.prevEnd).toBe(+w.periodStart);
        }
    });
});

describe('quarterly — 90, 91 and 92 days are all real quarters', () => {
    test('Q3 2026 is 92 days and Q2 2026 is 91', () => {
        const w = windowFor('quarterly', at('2026-10-15T00:00:00Z'));
        expect(iso(w.periodStart)).toBe('2026-07-01T00:00:00.000Z');
        expect(iso(w.periodEnd)).toBe('2026-10-01T00:00:00.000Z');
        expect(w.days).toBe(92);
        expect(w.prevDays).toBe(91);
        expect(w.bucket).toBe('2026-Q3');
        // Comparing these two windows on VOLUME without saying so would invent a
        // 1 % move out of the calendar alone.
        expect(w.days === w.prevDays).toBe(false);
    });

    test('an early-January anchor reports Q4 of the previous year', () => {
        const w = windowFor('quarterly', at('2026-01-05T00:00:00Z'));
        expect(w.bucket).toBe('2025-Q4');
        expect(iso(w.periodStart)).toBe('2025-10-01T00:00:00.000Z');
        expect(iso(w.prevStart)).toBe('2025-07-01T00:00:00.000Z');
    });

    test('every quarter starts on the first of a quarter month', () => {
        for (const m of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
            const w = windowFor('quarterly', new Date(Date.UTC(2026, m, 17)));
            expect([0, 3, 6, 9]).toContain(w.periodStart.getUTCMonth());
            expect(w.periodStart.getUTCDate()).toBe(1);
            expect([90, 91, 92]).toContain(w.days);
        }
    });
});

describe('yearly — a leap year is 366 days', () => {
    test('2024 is 366 days, 2023 is 365', () => {
        const w = windowFor('yearly', at('2025-03-01T00:00:00Z'));
        expect(iso(w.periodStart)).toBe('2024-01-01T00:00:00.000Z');
        expect(iso(w.periodEnd)).toBe('2025-01-01T00:00:00.000Z');
        expect(w.days).toBe(366);
        expect(w.prevDays).toBe(365);
        expect(w.bucket).toBe('2024');
        expect(fmtPeriodBound(w.displayEnd)).toBe('31/12/2024');
    });

    test('1 January 00:00 UTC reports the year that just closed', () => {
        const w = windowFor('yearly', at('2026-01-01T00:00:00Z'));
        expect(w.bucket).toBe('2025');
        expect(w.prevBucket).toBe('2024');
        expect(w.prevDays).toBe(366);
    });
});

describe('one clock: the server timezone cannot move a boundary', () => {
    const snapshot = (w) =>
        [iso(w.periodStart), iso(w.periodEnd), iso(w.prevStart), w.bucket, w.days].join('|');

    test('the same anchor yields the same window under any process TZ', () => {
        const anchor = at('2026-01-01T00:30:00Z'); // 31/12/2025 anywhere west of UTC
        const original = process.env.TZ;
        try {
            process.env.TZ = 'UTC';
            const utc = CADENCES.map((c) => snapshot(windowFor(c, anchor)));
            process.env.TZ = 'Pacific/Auckland';
            const nz = CADENCES.map((c) => snapshot(windowFor(c, anchor)));
            process.env.TZ = 'America/Los_Angeles';
            const la = CADENCES.map((c) => snapshot(windowFor(c, anchor)));
            expect(nz).toEqual(utc);
            expect(la).toEqual(utc);
        } finally {
            if (original === undefined) delete process.env.TZ;
            else process.env.TZ = original;
        }
    });

    test('every bound is midnight UTC', () => {
        for (const c of CADENCES) {
            const w = windowFor(c, at('2026-08-19T23:45:00Z'));
            for (const d of [w.periodStart, w.periodEnd, w.prevStart, w.prevEnd]) {
                expect(d.getUTCHours()).toBe(0);
                expect(d.getUTCMinutes()).toBe(0);
                expect(d.getUTCSeconds()).toBe(0);
                expect(d.getUTCMilliseconds()).toBe(0);
            }
        }
    });

    test('the closed period never reaches into the future', () => {
        const anchor = at('2026-08-19T23:45:00Z');
        for (const c of CADENCES) expect(windowFor(c, anchor).periodEnd <= anchor).toBe(true);
    });
});

describe('the horizon is indexed on the cadence, never wider', () => {
    test('14 / 30 / 90 / 180 days', () => {
        expect(HORIZON_DAYS).toEqual({ weekly: 14, monthly: 30, quarterly: 90, yearly: 180 });
    });

    test('horizonEnd is periodEnd plus exactly the horizon', () => {
        for (const c of CADENCES) {
            const w = windowFor(c, at('2026-05-17T00:00:00Z'));
            expect(w.horizonEnd - w.periodEnd).toBe(HORIZON_DAYS[c] * 86400000);
        }
    });

    test('the catch-up window is 6 / 20 / 30 / 60 days', () => {
        expect(CATCH_UP_DAYS).toEqual({ weekly: 6, monthly: 20, quarterly: 30, yearly: 60 });
    });

    test('daysSinceClose drives the catch-up test', () => {
        const w = windowFor('weekly', at('2026-09-13T07:00:00Z')); // closed 07/09
        expect(daysSinceClose(w, at('2026-09-09T06:00:00Z'))).toBe(2);
        expect(daysSinceClose(w, at('2026-09-20T06:00:00Z'))).toBe(13);
        expect(daysSinceClose(w, at('2026-09-20T06:00:00Z')) > w.catchUpDays).toBe(true);
    });
});

describe('the display bound is inclusive, and printed in UTC', () => {
    test('displayEnd is periodEnd minus one day', () => {
        for (const c of CADENCES) {
            const w = windowFor(c, at('2026-05-17T00:00:00Z'));
            expect(w.periodEnd - w.displayEnd).toBe(86400000);
        }
    });

    test('fmtPeriodBound is dd/MM/yyyy and ignores APP_TIMEZONE', () => {
        const original = process.env.APP_TIMEZONE;
        try {
            process.env.APP_TIMEZONE = 'Pacific/Auckland';
            // Midnight UTC is 13:00 the SAME day in Auckland but the day BEFORE in
            // any negative offset — a period bound must not shift either way.
            expect(fmtPeriodBound(new Date('2026-01-01T00:00:00Z'))).toBe('01/01/2026');
            process.env.APP_TIMEZONE = 'America/Los_Angeles';
            expect(fmtPeriodBound(new Date('2026-01-01T00:00:00Z'))).toBe('01/01/2026');
        } finally {
            if (original === undefined) delete process.env.APP_TIMEZONE;
            else process.env.APP_TIMEZONE = original;
        }
    });

    test('an absent bound renders the em dash, never "Invalid Date"', () => {
        expect(fmtPeriodBound(null)).toBe('—');
        expect(fmtPeriodBound('not a date')).toBe('—');
    });
});

describe('refusals', () => {
    test('an unknown cadence throws instead of guessing', () => {
        expect(() => windowFor('fortnightly', new Date())).toThrow(/cadence/);
        expect(() => bucketFor('fortnightly', new Date())).toThrow(/cadence/);
    });

    test('an unparsable anchor throws', () => {
        expect(() => windowFor('weekly', 'the day before yesterday')).toThrow(/anchor/);
    });
});
