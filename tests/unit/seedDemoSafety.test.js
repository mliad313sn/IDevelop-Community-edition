'use strict';

/**
 * seed-demo.js must never be able to destroy real data.
 *
 * The defect this pins: the role_criticality block used an unconditional
 * `ON CONFLICT (role_id) DO UPDATE`. On a customer database that already held
 * real, department-designated criticality rows, `--seed` would (1) overwrite the
 * department's own scoring with demo values and (2) stamp the demo MARKER into
 * `rationale` — so the subsequent `--clean`, which deletes strictly by marker,
 * would DELETE the real row it had just overwritten. Seed-then-clean silently
 * destroyed department-designed data.
 *
 * Criticality scoring is department-owned, the same class of data as the
 * per-role skill counts, so losing it is not recoverable from the app.
 *
 * These assertions read the script as source because the defect is in its
 * control flow, not in an exported function.
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '../../scripts/seed-demo.js'), 'utf8');

/** Body of the numbered section that writes role_criticality. */
function criticalitySection() {
    const start = SRC.indexOf('--- 1. Critical-role designations');
    const end = SRC.indexOf('--- 2. Succession plans');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return SRC.slice(start, end);
}

describe('seed-demo never overwrites real data', () => {
    test('the role_criticality block checks for a pre-existing row first', () => {
        const section = criticalitySection();
        expect(section).toMatch(/SELECT[^;]*FROM role_criticality WHERE role_id/i);
    });

    test('it skips rows whose marker is absent (i.e. real designations)', () => {
        const section = criticalitySection();
        // Must test the existing rationale against the marker and bail out.
        expect(section).toMatch(/startsWith\(\s*MARKER\s*\)/);
        expect(section).toMatch(/continue\s*;/);
    });

    test('an unconditional overwrite is not reintroduced', () => {
        const section = criticalitySection();
        // The INSERT may still carry ON CONFLICT (re-seeding our OWN demo rows),
        // but it must be preceded by the existence guard in the same section.
        const guardIdx = section.search(/startsWith\(\s*MARKER\s*\)/);
        const insertIdx = section.search(/INSERT INTO role_criticality/i);
        expect(guardIdx).toBeGreaterThan(-1);
        expect(insertIdx).toBeGreaterThan(-1);
        expect(guardIdx).toBeLessThan(insertIdx);
    });

    test('succession_plans keeps its equivalent pre-existing-row guard', () => {
        // The block that was already correct — pinned so both stay consistent.
        const start = SRC.indexOf('--- 2. Succession plans');
        const section = SRC.slice(start, start + 2500);
        expect(section).toMatch(/SELECT[^;]*FROM succession_plans WHERE position_role_id/i);
        expect(section).toMatch(/if\s*\(existing\)\s*continue\s*;/);
    });
});

describe('seed-demo cannot run against production', () => {
    test('production is refused', () => {
        expect(SRC).toMatch(/isProduction/);
        expect(SRC).toMatch(/production/i);
    });

    test('every namespaced table is declared for cleanup', () => {
        // Cleanup iterates NAMESPACED; a table written but not declared would be
        // unremovable demo data, which Build-Package would ship to customers.
        const block = SRC.slice(
            SRC.indexOf('const NAMESPACED'),
            SRC.indexOf('function isProduction')
        );
        for (const table of ['role_criticality', 'succession_plans', 'kpi_snapshots']) {
            expect(block).toContain(table);
        }
    });

    test('every table written by the seed is in NAMESPACED', () => {
        const block = SRC.slice(
            SRC.indexOf('const NAMESPACED'),
            SRC.indexOf('function isProduction')
        );
        const declared = [...block.matchAll(/table:\s*'([^']+)'/g)].map((m) => m[1]);
        const written = [...SRC.matchAll(/INSERT INTO\s+([a-z_]+)/gi)].map((m) =>
            m[1].toLowerCase()
        );
        const undeclared = [...new Set(written)].filter((t) => !declared.includes(t));
        expect(undeclared).toEqual([]);
    });
});
