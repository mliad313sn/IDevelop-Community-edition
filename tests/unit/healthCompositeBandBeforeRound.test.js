'use strict';

/**
 * A7 — the org/role health composite was ROUNDED before it was banded.
 *
 *   const composite = Math.round(weighted / weightSum);
 *   if (composite >= 80) status = 'healthy';
 *
 * A true composite of 79.5 rounds to 80 and is labelled "healthy", though it sits
 * below the healthy threshold (and 59.5 → 60 → "moderate"). The band now reads
 * the UNROUNDED value; the displayed score stays rounded.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const DashboardModel = require('../../src/models/DashboardModel');
const band = DashboardModel.bandHealthStatus;

describe('health composite is banded on the unrounded value (A7)', () => {
    test('79.5 is moderate, not healthy (does not round up across the 80 band)', () => {
        expect(band(79.5)).toBe('moderate');
        expect(band(79.99)).toBe('moderate');
    });

    test('59.5 is at-risk, not moderate', () => {
        expect(band(59.5)).toBe('at-risk');
    });

    test('39.5 is critical, not at-risk', () => {
        expect(band(39.5)).toBe('critical');
    });

    test('the exact thresholds still band up', () => {
        expect(band(80)).toBe('healthy');
        expect(band(60)).toBe('moderate');
        expect(band(40)).toBe('at-risk');
        expect(band(39.9)).toBe('critical');
        expect(band(100)).toBe('healthy');
        expect(band(0)).toBe('critical');
    });

    test('the model bands on compositeExact, not the rounded composite', () => {
        const fs = require('fs');
        const path = require('path');
        const src = fs
            .readFileSync(path.join(__dirname, '../../src/models/DashboardModel.js'), 'utf8')
            .replace(/\s+/g, ' ');
        expect(src).toMatch(/const status = bandHealthStatus\(compositeExact\)/);
        // the old round-then-band shape is gone
        expect(src).not.toMatch(/if \(composite >= 80\) status = 'healthy'/);
    });
});
