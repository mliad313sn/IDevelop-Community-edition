'use strict';

/**
 * Re-audit A8 + A9 (latent divergences on the dashboard).
 *
 * A8 — "roles at risk" was computed two ways: the KPI query's is_role_ready
 *      criterion (persisted to kpi_snapshots and drawn on the trend) and the
 *      live card's staffing criterion (readiness_assessed_only >= 80). They agree
 *      today but would let the live number and the trend history disagree. The
 *      card now reads kpis.rolesAtRisk, the same value the trend stores.
 * A9 — getReadinessByGroup grouped by NAME (a department/service name spans many
 *      ids across sites) yet projected MAX(id) as a single representative — an
 *      arbitrary id that would scope a drill-through to one site if ever used.
 *      The id projection is gone; consumers key off the name.
 *
 * Source-shape, whitespace-tolerant.
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

describe('A8 — the roles-at-risk card and the trend share one definition', () => {
    const flat = read('public/js/dashboard.js').replace(/\s+/g, ' ');
    test('the card prefers the KPI-query rolesAtRisk, falling back to staffing', () => {
        expect(flat).toMatch(
            /const riskCount = kpis\.rolesAtRisk != null \? num\(kpis\.rolesAtRisk, 0\) : staffing\.filter\(\(r\) => r\.isRisk && !r\.isUnmeasured\)\.length/
        );
    });
});

describe('A9 — readiness-by-group projects no arbitrary representative id', () => {
    const model = read('src/models/DashboardModel.js');
    const flat = model.replace(/\s+/g, ' ');
    test('getReadinessByGroup no longer selects MAX(...) as id', () => {
        // locate the getReadinessByGroup SQL and assert the id projection is gone
        const idx = model.indexOf('async getReadinessByGroup');
        expect(idx).toBeGreaterThan(-1);
        const body = model.slice(idx, idx + 2000);
        expect(body).not.toMatch(/MAX\(e\.\$\{groupId\}\) as id/);
        expect(body).not.toMatch(/as id, -- simplified/);
    });
    test('the group SELECT still leads with the name label', () => {
        expect(flat).toMatch(
            /SELECT e\.\$\{groupCol\} as label, ROUND\(AVG\(c\.readiness_assessed_only\), 1\) as avgReadiness/
        );
    });
});
