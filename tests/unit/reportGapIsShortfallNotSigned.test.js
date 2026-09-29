'use strict';

/**
 * Re-audit R4 (the concrete-harm sub-part) — the Report Builder exposed `gap` as
 * an aggregatable measure over a SIGNED value (required_level - assessed_level),
 * negative when someone exceeds the requirement. A SUM/AVG then let one
 * over-qualified person cancel another's shortfall and understate the deficit
 * (proved on idevelop_fixtures: 444 rows where assessed exceeds required carried a
 * negative raw gap). A competency "gap" is a SHORTFALL: it is now clamped at 0,
 * "exceeds" reads as met (is_met already says so), and unmeasured stays NULL.
 *
 * The other R4 sub-parts are latent/deliberate and left documented: the
 * v_resolved_assessments tie-break is intentionally assessed_at DESC only
 * (migration 71, so no resolved level shifts); assessed_level's 0-vs-NULL
 * meaning across views has no identified broken consumer; skills.sub_domain_id
 * is legitimately nullable (the import allows it) so the capability-view INNER
 * JOIN is tracked, not forced (0 occurrences today).
 */

const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(
    path.join(__dirname, '../../src/services/ReportDataService.js'),
    'utf8'
);
const flat = src.replace(/\s+/g, ' ');

describe('R4 — the report gap measure is a shortfall, never a signed value', () => {
    test('the gap column clamps at 0 (exceeds is not a negative gap)', () => {
        expect(flat).toMatch(
            /ELSE GREATEST\(p\.required_level - p\.assessed_level, 0\) END AS gap/
        );
        // the old signed form is gone
        expect(flat).not.toMatch(/ELSE \(p\.required_level - p\.assessed_level\) END AS gap/);
    });

    test('an unmeasured requirement is still NULL, not a clamped 0', () => {
        expect(flat).toMatch(/CASE WHEN p\.assessed_level IS NULL THEN NULL ELSE GREATEST/);
    });

    test('is_met and the gapsOnly filter are unchanged (met = meets or exceeds)', () => {
        expect(flat).toMatch(
            /WHEN p\.assessed_level >= p\.required_level THEN 1 ELSE 0 END AS is_met/
        );
        expect(flat).toMatch(/gapsOnly && schema\.flags\.gap/);
    });
});
