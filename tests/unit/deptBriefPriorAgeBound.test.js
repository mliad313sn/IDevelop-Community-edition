'use strict';

/**
 * Re-audit J5 — the departmental brief compared the current period against the
 * most recent EARLIER brief of the same scope regardless of how old it was, and
 * labelled that "comparable". If a recipient's briefs had been paused (they were
 * inactive, or the cadence was off for months), the arrow compared across an
 * unmeasured gap and read as a normal period-over-period change. Twin of the
 * snapshot MAX_PRIOR_AGE_FACTOR fix: a prior more than N of the cadence's own
 * periods behind is a stale baseline and must render as a first measure.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

// DeptBriefService touches the DB only inside its query functions; _priorTooOld
// is pure, so a stub client is enough for the require.
jest.mock('../../src/config/database', () => ({
    get: jest.fn(async () => null),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({})),
    inTransaction: () => false,
}));

const S = require('../../src/services/DeptBriefService');
const brief = (start, end) => ({
    periodStart: new Date(start),
    periodEnd: new Date(end),
    scopeSignature: 'x',
});

describe('J5 — a stale prior brief is not a comparable baseline', () => {
    test('the age factor mirrors the snapshot one', () => {
        expect(S.MAX_PRIOR_BRIEF_AGE_FACTOR).toBe(3);
    });

    test('the immediately-preceding monthly brief IS comparable', () => {
        // prev covers Aug (31d span); current period starts Sep 1 — one period back.
        const prev = brief('2026-08-01', '2026-09-01');
        expect(S._priorTooOld(prev, new Date('2026-09-01'))).toBe(false);
    });

    test('exactly the factor back is still usable, one day past it is stale', () => {
        const prev = brief('2026-06-01', '2026-07-01'); // 30-day span
        // 3 * 30 = 90 days after prevStart is the boundary.
        expect(S._priorTooOld(prev, new Date('2026-08-30'))).toBe(false); // 90 days → on the boundary
        expect(S._priorTooOld(prev, new Date('2026-09-01'))).toBe(true); // 92 days → stale
    });

    test('a brief six months old is a stale baseline', () => {
        const prev = brief('2026-03-01', '2026-04-01');
        expect(S._priorTooOld(prev, new Date('2026-09-01'))).toBe(true);
    });

    test('unknown bounds keep the prior rather than dropping it silently', () => {
        expect(S._priorTooOld({ periodStart: null, periodEnd: null }, new Date('2026-09-01'))).toBe(
            false
        );
        expect(S._priorTooOld(null, new Date('2026-09-01'))).toBe(false);
    });
});
