'use strict';

/**
 * Re-audit R3 — an APPROVED self-assessment with a NULL self_rated_level produced
 * a NULL-level "self_approved" row in v_resolved_assessments that, being the most
 * recent, could WIN the tie-break and suppress a real supervisor-validated level
 * (turning a measured skill into "not measured" and breaking the coverage-view
 * identity). It cannot come from the app but a bulk import or the super-admin SQL
 * Console could write it. Migration 142 adds a CHECK on the real table
 * (self_assessment_rounds) so the row can never exist, and filters the self branch
 * of v_resolved_assessments as belt-and-suspenders.
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

describe('R3 — an approved self-rating must carry a level', () => {
    const mig = read('db/postgres/142_approved_self_rating_not_null.sql');

    test('the CHECK is on the real table, not the compat view', () => {
        expect(mig).toMatch(/ALTER TABLE self_assessment_rounds/);
        expect(mig).not.toMatch(/ALTER TABLE self_assessments\b/);
    });

    test('the CHECK forbids approved + NULL level', () => {
        expect(mig).toMatch(
            /CHECK \(status <> 'approved'::self_assessment_state OR self_rated_level IS NOT NULL\)/
        );
    });

    test('the constraint add is idempotent (guarded by pg_constraint)', () => {
        expect(mig).toMatch(
            /IF NOT EXISTS \(\s*SELECT 1 FROM pg_constraint WHERE conname = 'self_assessment_rounds_approved_has_level'/
        );
    });

    test('the resolved-assessment self branch ignores an approved row with no level', () => {
        const flat = mig.replace(/\s+/g, ' ');
        expect(flat).toMatch(
            /FROM self_assessments WHERE status = 'approved' AND self_rated_level IS NOT NULL/
        );
    });
});
