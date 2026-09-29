'use strict';

/**
 * T2 — the ready_1_2y band had no coverage floor: 75 % on ONE of 161 requirements
 *      banded "ready in 1-2 years", and unknown coverage (null) was treated as a
 *      pass (default 100). Both ready bands now require enough of the role
 *      measured, and unknown coverage never passes a floor.
 *
 * T6 — successors.confidence was derived from fit alone, so a 4-of-63 candidate
 *      read as confident (1.000) as a fully-evidenced one. It is now fit ×
 *      coverage, so thin evidence lowers confidence.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const Cont = require('../../src/services/ContinuityService');

describe('T2 — both ready bands need enough coverage', () => {
    test('a thin-coverage candidate is not banded ready_1_2y', () => {
        expect(Cont.bandFromReadiness(75, 0.6)).toBe('ready_3y'); // was ready_1_2y
        expect(Cont.bandFromReadiness(75, Cont.READY_1_2Y_COVERAGE_FLOOR)).toBe('ready_1_2y');
        expect(Cont.bandFromReadiness(75, Cont.READY_1_2Y_COVERAGE_FLOOR - 0.1)).toBe('ready_3y');
    });

    test('ready_now still needs its 80 % floor, and pct itself', () => {
        expect(Cont.bandFromReadiness(95, 90)).toBe('ready_now');
        expect(Cont.bandFromReadiness(95, 79)).toBe('ready_1_2y'); // high fit, thin cov → down a band
        expect(Cont.bandFromReadiness(85, 90)).toBe('ready_1_2y'); // below 90 pct
    });

    test('unknown coverage (null) never passes a floor', () => {
        expect(Cont.bandFromReadiness(95, null)).toBe('ready_3y');
        expect(Cont.bandFromReadiness(75, null)).toBe('ready_3y');
    });

    test('nothing measured is the lowest band', () => {
        expect(Cont.bandFromReadiness(null, null)).toBe('ready_3y');
    });
});

describe('T6 — confidence reflects fit AND coverage', () => {
    test('a high fit on thin coverage is low confidence, not 1.000', () => {
        expect(Cont.confidenceFrom(100, 6)).toBe('0.060'); // was 1.000
        expect(Cont.confidenceFrom(90, 100)).toBe('0.900');
        expect(Cont.confidenceFrom(100, 100)).toBe('1.000');
    });

    test('nothing measured is NULL confidence, never a zero', () => {
        expect(Cont.confidenceFrom(null, null)).toBeNull();
    });

    test('unknown coverage collapses confidence to 0.000, not fit', () => {
        expect(Cont.confidenceFrom(100, null)).toBe('0.000');
    });
});
