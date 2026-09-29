'use strict';

/**
 * Re-audit A1 — the "role ready" threshold had two sources. ReadinessService (JS)
 * banded at the admin setting readinessThreshold (default 80); the SQL view
 * v_employee_readiness.is_role_ready hard-coded >= 80. Both otherwise apply the
 * SAME rule (all-requirement readiness >= threshold AND every critical
 * requirement met), so at a threshold of 60 the report and the dashboard
 * disagreed on who is ready — proved against idevelop_fixtures: is_role_ready counted
 * 48 people ready at 80 and 65 at 60. Migration 141 routes the view through
 * app_readiness_threshold(), which reads the same setting, so both surfaces move
 * together.
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

describe('A1 — one configurable readiness threshold, read by both the view and the service', () => {
    const mig = read('db/postgres/141_readiness_threshold_setting.sql');
    const svc = read('src/services/ReadinessService.js');

    test('the migration defines the threshold function against the readinessThreshold setting', () => {
        expect(mig).toMatch(
            /CREATE OR REPLACE FUNCTION app_readiness_threshold\(\) RETURNS numeric/
        );
        expect(mig).toMatch(/setting_key = 'readinessThreshold'/);
        // A malformed value must not crash a readiness query — it falls back to 80.
        expect(mig).toMatch(/COALESCE\(/);
        expect(mig).toMatch(/,\s*80\s*\)/);
        expect(mig).toMatch(/~ '\^\[0-9\]\+\(\\\.\[0-9\]\+\)\?\$'/);
    });

    test('is_role_ready reads the function, and the old hard-coded 80 is gone from it', () => {
        const flat = mig.replace(/\s+/g, ' ');
        expect(flat).toMatch(/>= app_readiness_threshold\(\)\s+AND SUM\(CASE WHEN g\.is_critical/);
        // The only remaining literal 80 in the file is the function's fallback,
        // never the band comparison.
        expect(flat).not.toMatch(/\/ SUM\(g\.required_level\)::numeric\) >= 80\b/);
    });

    test('CREATE OR REPLACE keeps is_role_ready an integer flag (no column-type change)', () => {
        expect(mig).toMatch(/THEN 1 ELSE 0 END AS is_role_ready/);
    });

    test('ReadinessService bands on the SAME setting and default', () => {
        expect(svc).toMatch(/AppSettingsModel\.getValue\('readinessThreshold', 80\)/);
        expect(svc).toMatch(/readinessAllRequirements >= readinessThreshold/);
    });
});
